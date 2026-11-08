// Sensmos Hub — nod bez płytki. Rejestruje się w BE jak nod z FW, mówi protokołem WS (ws.md),
// mierzy łącze (measure.md) i otwiera tunel v2 do urządzeń w LAN (tunel.md), np. panelu Home Assistant.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const identity = require('./identity');
const { Channel, VER_TUN } = require('./wsenc');
const measure = require('./measure');
const { Pairing, Tunnels } = require('./tunnel');
const lan = require('./lan');
const mdns = require('./mdns');
const BE_PUB = require('./be_pub');
const diag = require('./diag');
const ha = require('./ha');

const FIRMWARE = 'hub-' + require('../package.json').version;
const QUIET = new Set(['cn_config', 'tasks_update', 'tasks_clear', 'config_ack', 'batch_ack', 'monitor_set', 'monitor_clear', 'check_config', 'subscription_push', 'lora_msg_seed', 'fw_digest', 'pong']);

class Hub {
    constructor(cfg) {
        this.cfg = { be: 'https://sensmos.com', port: 80, bePub: BE_PUB, pingS: 30, checkS: 600, backoffS: 5,
            ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== '')) };
        this.cfg.be = this.cfg.be.replace(/\/$/, '');
        if (!/^0x[0-9a-fA-F]{40}$/.test(this.cfg.owner || '')) throw new Error('HUB_OWNER: podaj adres portfela z apki Sensmos (0x…)');
        fs.mkdirSync(this.cfg.data, { recursive: true });
        // Każda linia logu trafia też do bufora zdarzeń na dysku (paczka diagnostyczna, `diag`).
        this.debug = this.cfg.debug === true || /^(debug|1|true)$/i.test(process.env.SENSMOS_LOG || '');
        this.events = new diag.Events(this.cfg.data);
        const out = cfg.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a));
        this.log = (...a) => { this.events.push(a.join(' ')); out(...a); };
        this.id = identity.load(this.cfg.data);
        this.pairing = new Pairing(this.cfg.data);
        this.pin = this.loadPin();
        this.registeredFile = path.join(this.cfg.data, 'registered.json');
        this.ws = null; this.chan = null; this.tunnels = null; this.stopping = false; this.backoffS = this.cfg.backoffS;
        this.seen = new Set();
        this.listeners = new Map();
    }

    on(ev, fn) { (this.listeners.get(ev) || this.listeners.set(ev, []).get(ev)).push(fn); return this; }
    emit(ev, ...a) { for (const fn of this.listeners.get(ev) || []) fn(...a); }

    loadPin() {
        if (/^\d{6}$/.test(this.cfg.pin || '')) return this.cfg.pin;
        const f = path.join(this.cfg.data, 'pin.txt');
        try { const p = fs.readFileSync(f, 'utf8').trim(); if (/^\d{6}$/.test(p)) return p; } catch {}
        const p = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
        fs.writeFileSync(f, p + '\n', { mode: 0o600 });
        return p;
    }

    async start() {
        diag.writeState(this.cfg.data, { version: FIRMWARE });
        this.log(`Sensmos Hub ${FIRMWARE} — device_id ${this.id.id}`);
        this.log(`PIN hubu: ${this.pin} (apka pyta o niego przy parowaniu i eksporcie)`);
        this.lan = lan.start({ port: this.cfg.port, pin: this.pin, identity: this.id, pairing: this.pairing, firmware: FIRMWARE, owner: this.cfg.owner,
            sensors: () => this.ha?.snapshot() || null,
            log: this.log, onPairingChange: () => this.ws?.close() });
        await new Promise(r => this.lan.once('listening', r));
        // apka szuka noda po nazwie sensmos-<id>.local i mówi do portu 80 (jak do płytki)
        if (this.cfg.mdns !== false) this.mdns = mdns.start({ deviceId: this.id.id, port: this.lan.address().port, firmware: FIRMWARE, log: this.log });
        // Czujniki z Home Assistanta (tylko odczyt, lokalnie): add-on → API Supervisora, Docker → HUB_HA_URL + HUB_HA_TOKEN.
        const haCfg = this.cfg.ha || ha.config();
        if (haCfg) this.ha = new ha.HaSensors({ cfg: haCfg, log: this.log, everyS: this.cfg.haEveryS || 60 }).start();
        else this.log('HA: brak dostępu do Home Assistanta (Docker: HUB_HA_URL + HUB_HA_TOKEN w .env) — czujniki wyłączone');
        try { await this.register(); } catch (e) { this.log(e.message); }
        this.connect();
        return this;
    }

    stop() {
        this.stopping = true;
        clearTimeout(this.retryT);
        this.tunnels?.closeAll();
        this.ws?.close();
        this.lan?.close();
        this.ha?.stop();
        this.mdns?.stop();
        this.events.stop();
    }

    async register() {
        try {
            const r = JSON.parse(fs.readFileSync(this.registeredFile, 'utf8'));
            if (r.owner === this.cfg.owner.toLowerCase() && r.be === this.cfg.be) return;
        } catch {}
        const nonce = crypto.randomBytes(16).toString('hex');
        const message = JSON.stringify({ device_id: this.id.id, owner: this.cfg.owner, nonce, ts: Math.floor(Date.now() / 1000) });
        const sig_esp = this.id.sign(message);
        const body = { message, pubkey: this.id.pubHex, sig_esp, proof: crypto.createHash('sha256').update(nonce + sig_esp + this.id.id).digest('hex') };
        const r = await fetch(`${this.cfg.be}/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const txt = await r.text();
        if (r.status === 403) throw new Error('ten hub jest już przypisany do innego portfela. Nowa tożsamość: usuń plik identity.json z katalogu danych.');
        if (!r.ok) throw new Error(`rejestracja w BE nieudana (${r.status}): ${txt}`);
        fs.writeFileSync(this.registeredFile, JSON.stringify({ owner: this.cfg.owner.toLowerCase(), be: this.cfg.be, at: new Date().toISOString() }) + '\n');
        this.log('zarejestrowany w BE; nod pojawi się w apce na liście nodów tego portfela');
        this.emit('registered');
    }

    send(obj) { if (this.chan && this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.chan.sealJson(obj)); }
    sendTun(tid, frame) { if (this.chan && this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.chan.sealTun(tid, frame)); }

    connect() {
        const hubNonce = this.hubNonce = crypto.randomBytes(16);
        this.chan = null;
        this.tunnels = new Tunnels({ pairing: this.pairing, deviceId: this.id.id, send: o => this.send(o), sendTun: (t, f) => this.sendTun(t, f), log: this.log });
        const ws = this.ws = new WebSocket(this.cfg.be.replace(/^http/, 'ws') + '/v1/ws');
        ws.on('open', () => {
            const ts = Math.floor(Date.now() / 1000);
            const msg = `identify:${this.id.id}:${ts}:e1:${hubNonce.toString('hex')}`;
            ws.send(JSON.stringify({
                type: 'identify', device_id: this.id.id, timestamp: ts, msg, signature: this.id.sign(msg),
                enc: 1, enonce: hubNonce.toString('hex'), firmware: FIRMWARE, proto: 2,
                ...(this.pairing.has() ? { remote: 1 } : {}),
                chip: `hub ${os.platform()}-${os.arch()} node${process.versions.node}`,
            }));
        });
        ws.on('message', (data, isBinary) => { try { this.onMessage(data, isBinary); } catch (e) { this.log('błąd obsługi wiadomości:', e.message); } });
        ws.on('error', e => this.log('WS:', e.message));
        ws.on('close', () => this.onClose());
    }

    onMessage(data, isBinary) {
        const ws = this.ws;
        {
            if (!isBinary) {
                let m; try { m = JSON.parse(data.toString()); } catch { return; }
                if (m.type === 'identified') return this.onIdentified(m, this.hubNonce);
                if (m.type === 'error') {
                    this.log('BE:', m.msg);
                    if (m.msg === 'device not registered') { try { fs.unlinkSync(this.registeredFile); } catch {} }
                    if (m.msg === 'update_required') this.log(`BE wymaga proto ≥ ${m.proto_min}; zaktualizuj hub`);
                }
                return;
            }
            if (!this.chan) return;
            const r = this.chan.open(Buffer.from(data));
            if (!r) return;
            if (r.ver === VER_TUN) { if (r.plaintext.length > 2) this.tunnels.onFrame(r.plaintext.readUInt16BE(0), r.plaintext.subarray(2)); return; }
            let m; try { m = JSON.parse(r.plaintext.toString('utf8')); } catch { return; }
            this.handle(m);
        }
    }

    onClose() {
        {
            clearInterval(this.pingT); clearInterval(this.checkT);
            this.tunnels?.closeAll();
            this.chan = null;
            this.emit('disconnected');
            if (this.stopping) return;
            this.log(`rozłączony; ponowna próba za ${this.backoffS} s`);
            this.retryT = setTimeout(() => this.register().then(() => this.connect()).catch(e => { this.log(e.message); this.retryT = setTimeout(() => this.connect(), this.backoffS * 1000); }), this.backoffS * 1000);
            this.backoffS = Math.min(this.backoffS * 2, 120);
        }
    }

    onIdentified(m, hubNonce) {
        if (m.status === 'deleted') {
            this.log('nod został usunięty z konta w apce. Zatrzymuję się; żeby dodać go ponownie, uruchom hub jeszcze raz.');
            try { fs.unlinkSync(this.registeredFile); } catch {}
            this.stop();
            this.emit('deleted');
            return;
        }
        if (!m.enonce) { this.log('BE nie otworzył kanału szyfrowanego'); this.ws.close(); return; }
        this.chan = new Channel(this.id.ecdh, Buffer.from(this.cfg.bePub, 'hex'), hubNonce, Buffer.from(m.enonce, 'hex'));
        this.backoffS = this.cfg.backoffS;
        this.log(`połączony z ${this.cfg.be} jako ${this.id.id.slice(0, 16)}… (${FIRMWARE}${this.pairing.has() ? ', sparowany' : ', niesparowany'})`);
        this.ping();
        this.pingT = setInterval(() => this.ping(), this.cfg.pingS * 1000);
        this.send({ type: 'check_assign' });
        this.checkT = setInterval(() => this.send({ type: 'check_assign' }), this.cfg.checkS * 1000);
        this.emit('connected');
    }

    ping() {
        const free = Math.min(os.freemem(), 2147483647);
        this.send({ type: 'ping', device_id: this.id.id, free, largest: free });
    }

    handle(m) {
        this.emit('message', m);
        if (this.debug && m.type !== 'check_jobs') this.log('BE →', m.type);
        switch (m.type) {
            case 'check_jobs':
                measure.run(m.jobs).then(recs => { if (recs.length) { this.send({ type: 'measure', v: 1, m: recs }); this.log(`measure: ${recs.length} rekordów`); } });
                return;
            case 'tun_open': return this.tunnels.onOpen(m);
            case 'tun_close': return this.tunnels.onClose(m);
            case 'reboot': this.log('BE prosi o restart; łączę ponownie'); return this.ws.close();
            case 'deleted': return this.onIdentified({ status: 'deleted' });
            case 'ota': this.log('OTA nie dotyczy hubu (aktualizacja = nowy obraz Dockera)'); return;
            case 'message': this.log('wiadomość:', JSON.stringify(m).slice(0, 200)); return;
            default:
                if (this.debug) this.log('BE →', m.type, JSON.stringify(m).slice(0, 300));
                else if (!QUIET.has(m.type) && !this.seen.has(m.type)) { this.seen.add(m.type); this.log('nieobsługiwany typ z BE:', m.type); }
        }
    }
}

module.exports = { Hub, FIRMWARE, diag };
