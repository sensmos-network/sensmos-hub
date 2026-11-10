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
const { History } = require('./history');
const { Lora } = require('./lora');
const { HaLora } = require('./ha_lora');

const FIRMWARE = 'hub-' + require('../package.json').version;
const QUIET = new Set(['cn_config', 'tasks_update', 'tasks_clear', 'config_ack', 'batch_ack', 'monitor_set', 'monitor_clear', 'check_config', 'subscription_push', 'lora_msg_seed', 'fw_digest', 'pong', 'lora_cfg', 'lora_scan', 'lora_camp', 'lora_listen', 'lora_cad', 'lora_hunt', 'lora_bg']);

class Hub {
    constructor(cfg) {
        this.cfg = { be: 'https://sensmos.com', port: 80, bePub: BE_PUB, pingS: 30, checkS: 600, backoffS: 5,
            ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== '')) };
        this.cfg.be = this.cfg.be.replace(/\/$/, '');
        if (!/^0x[0-9a-fA-F]{40}$/.test(this.cfg.owner || '')) throw new Error('HUB_OWNER: set the wallet address from the Sensmos app (0x…)');
        fs.mkdirSync(this.cfg.data, { recursive: true });
        // Każda linia logu trafia też do bufora zdarzeń na dysku (paczka diagnostyczna, `diag`).
        this.debug = this.cfg.debug === true || /^(debug|1|true)$/i.test(process.env.SENSMOS_LOG || '');
        this.events = new diag.Events(this.cfg.data);
        const out = cfg.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a));
        this.log = (...a) => { this.events.push(a.join(' ')); out(...a); };
        this.logLocal = out;   // tylko konsola: sekrety (PIN) nie mogą trafić do events.json i paczki diag
        this.id = identity.load(this.cfg.data);
        this.pairing = new Pairing(this.cfg.data);
        this.pin = this.loadPin();
        // Czujniki LoRa przez sieć (Hub nie ma radia): ramki DATA do Hubu dowozi BE, Hub dekoduje kluczem z frazy.
        this.lora = new Lora({ dir: this.cfg.data, deviceId: this.id.id, log: this.log, send: o => this.send(o) });
        if (this.cfg.loraKey) this.lora.configure({ key: this.cfg.loraKey });   // opcja dodatku / HUB_LORA_KEY
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
        this.log(`LoRa: sensors send to id ${this.lora.id8} (key ${this.lora.key ? 'set' : 'not set'}${this.lora.open ? ', plain frames accepted' : ''})`);
        this.logLocal(`Hub PIN: ${this.pin} (the app asks for it when pairing and exporting)`);
        this.lan = lan.start({ port: this.cfg.port, pin: this.pin, identity: this.id, pairing: this.pairing, firmware: FIRMWARE, owner: this.cfg.owner,
            sensors: () => this.ha?.snapshot() || null, shared: this.shared = new ha.Shared(this.cfg.data),
            data: () => this.dataView(), lora: this.lora, connected: () => !!this.chan, history: this.history = new History(this.cfg.data, { log: this.log }),
            log: this.log, onPairingChange: () => this.ws?.close() });
        await new Promise(r => this.lan.once('listening', r));
        // apka szuka noda po nazwie sensmos-<id>.local i mówi do portu 80 (jak do płytki)
        if (this.cfg.mdns !== false) this.mdns = mdns.start({ deviceId: this.id.id, port: this.lan.address().port, firmware: FIRMWARE, log: this.log });
        // Czujniki z Home Assistanta (tylko odczyt, lokalnie): add-on → API Supervisora, Docker → HUB_HA_URL + HUB_HA_TOKEN.
        const haCfg = this.cfg.ha || ha.config();
        if (haCfg) {
            this.ha = new ha.HaSensors({ cfg: haCfg, log: this.log, everyS: this.cfg.haEveryS || 60 }).start();
            // Ramki LoRa jako czujniki w HA (sensor.sensmos_lora_*), bez integracji z HACS. HUB_LORA_HA=0 wyłącza.
            if (this.cfg.loraHa !== false) this.haLora = new HaLora({ cfg: haCfg, lora: this.lora, log: this.log, everyS: this.cfg.loraHaEveryS || 300 }).start();
        } else this.log('HA: no access to Home Assistant (Docker: HUB_HA_URL + HUB_HA_TOKEN in .env) — sensors off');
        // Udostępnione czujniki co dataS: zapis do historii lokalnej zawsze, wysyłka do sieci gdy jest połączenie
        // (ten sam batch co ESP32, kanał szyfrowany, BE: onBatch → batch.js).
        this.dataT = setInterval(() => this.sendSensors(), (this.cfg.dataS || 300) * 1000);
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
        this.haLora?.stop();
        clearInterval(this.dataT);
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
        if (r.status === 403) throw new Error('this hub is already assigned to another wallet. For a new identity delete identity.json from the data folder.');
        if (!r.ok) throw new Error(`registration with the backend failed (${r.status}): ${txt}`);
        fs.writeFileSync(this.registeredFile, JSON.stringify({ owner: this.cfg.owner.toLowerCase(), be: this.cfg.be, at: new Date().toISOString() }) + '\n');
        this.log('registered with the backend; the node will show in the app on this wallet\'s node list');
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
        ws.on('message', (data, isBinary) => { try { this.onMessage(data, isBinary); } catch (e) { this.log('message handling error:', e.message); } });
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
                    if (m.msg === 'update_required') this.log(`backend requires proto ≥ ${m.proto_min}; update the hub`);
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
            this.log(`disconnected; retrying in ${this.backoffS} s`);
            this.retryT = setTimeout(() => this.register().then(() => this.connect()).catch(e => { this.log(e.message); this.retryT = setTimeout(() => this.connect(), this.backoffS * 1000); }), this.backoffS * 1000);
            this.backoffS = Math.min(this.backoffS * 2, 120);
        }
    }

    onIdentified(m, hubNonce) {
        if (m.status === 'deleted') {
            this.log('the node was removed from the account in the app. Stopping; to add it again, start the hub again.');
            try { fs.unlinkSync(this.registeredFile); } catch {}
            this.stop();
            this.emit('deleted');
            return;
        }
        if (!m.enonce) { this.log('backend did not open the encrypted channel'); this.ws.close(); return; }
        this.chan = new Channel(this.id.ecdh, Buffer.from(this.cfg.bePub, 'hex'), hubNonce, Buffer.from(m.enonce, 'hex'));
        this.backoffS = this.cfg.backoffS;
        this.log(`connected to ${this.cfg.be} as ${this.id.id.slice(0, 16)}… (${FIRMWARE}${this.pairing.has() ? ', paired' : ', not paired'})`);
        this.ping();
        this.pingT = setInterval(() => this.ping(), this.cfg.pingS * 1000);
        this.send({ type: 'check_assign' });
        this.checkT = setInterval(() => this.send({ type: 'check_assign' }), this.cfg.checkS * 1000);
        this.emit('connected');
    }

    sendSensors() {
        if (!this.ha || this.ha.error) return 0;   // HA niedostępny: nie udajemy świeżych odczytów
        const entities = ha.toEntities(this.ha.sensors, id => this.shared?.has(id));
        this.lastEntities = entities; this.lastAt = Math.floor(Date.now() / 1000);
        if (!entities.length) {
            if (this.lastSent && this.chan) { this.send({ type: 'batch', device_id: this.id.id, firmware: FIRMWARE, entities: [] }); this.log('sensors to network: 0 (withdrawn)'); }
            this.lastSent = 0;
            return 0;
        }
        this.history?.append(entities, this.lastAt);
        if (!this.chan) return 0;
        this.send({ type: 'batch', device_id: this.id.id, firmware: FIRMWARE, entities });
        if (this.lastSent !== entities.length) this.log(`sensors to network: ${entities.length} (${entities.map(e => e.entity_id).join(', ')})`);
        this.lastSent = entities.length;
        return entities.length;
    }

    // /data/status i /data/native w formacie płytki ESP32 (http_data.cpp), żeby integracja Sensmos w HA
    // i apka widziały Hub jak zwykły nod. Wartości jako stringi, age_s od ostatniego odczytu.
    dataView() {
        const now = Math.floor(Date.now() / 1000);
        const ents = this.lastEntities || [];
        const row = e => ({ entity_id: e.entity_id, value: String(e.value), unit: e.unit || '', age_s: Math.max(0, now - (e.last_updated || this.lastAt || now)) });
        const pub = ents.filter(e => e.entity_id.startsWith('pub.')).map(row), own = ents.filter(e => e.entity_id.startsWith('own.')).map(row);
        return {
            status: { device_id: this.id.id, buffer_count: ents.length, uptime_s: Math.floor(process.uptime()), pub, mon: [], own, pool: [] },
            native: { count: pub.length, entities: pub.map(p => ({ entity_id: p.entity_id.slice(4), pub_id: p.entity_id, value: p.value, unit: p.unit, age_s: p.age_s })) },
        };
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
                measure.run(m.jobs).then(recs => { if (recs.length) { this.send({ type: 'measure', v: 1, m: recs }); this.log(`measure: ${recs.length} records`); } });
                return;
            case 'tun_open': return this.tunnels.onOpen(m);
            case 'lora_frame': this.lora.onWs(m.hex); return;
            case 'lora_frame_tx':
                // BE prosi bazę o nadanie radiem do jej czujnika — Hub radia nie ma.
                if (!this.seen.has(m.type)) { this.seen.add(m.type); this.log('LoRa: frame to transmit by radio refused (the hub has no radio)'); }
                return;
            case 'tun_close': return this.tunnels.onClose(m);
            case 'reboot': this.log('backend asks for a restart; reconnecting'); return this.ws.close();
            case 'deleted': return this.onIdentified({ status: 'deleted' });
            case 'ota': this.log('OTA does not apply to the hub (update = new Docker image)'); return;
            case 'message': this.log('message:', JSON.stringify(m).slice(0, 200)); return;
            default:
                if (this.debug) this.log('BE →', m.type, JSON.stringify(m).slice(0, 300));
                else if (!QUIET.has(m.type) && !this.seen.has(m.type)) { this.seen.add(m.type); this.log('unhandled type from backend:', m.type); }
        }
    }
}

module.exports = { Hub, FIRMWARE, diag };
