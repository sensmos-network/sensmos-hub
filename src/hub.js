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
const { Meshtastic } = require('./meshtastic');
const { LoRaWan } = require('./lorawan');
const { EspHomeLora } = require('./esphome_lora');
const hubAttest = require('./attest');

const FIRMWARE = 'hub-' + require('../package.json').version;
const OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
const QUIET = new Set(['cn_config', 'tasks_update', 'tasks_clear', 'config_ack', 'batch_ack', 'monitor_set', 'monitor_clear', 'check_config', 'subscription_push', 'lora_msg_seed', 'fw_digest', 'pong', 'lora_cfg', 'lora_scan', 'lora_camp', 'lora_listen', 'lora_cad', 'lora_hunt', 'lora_bg']);

class Hub {
    constructor(cfg) {
        this.cfg = { be: 'https://sensmos.com', port: 80, bePub: BE_PUB, pingS: 30, checkS: 600, backoffS: 5,
            ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== '')) };
        this.cfg.be = this.cfg.be.replace(/\/$/, '');
        if (this.cfg.owner && !OWNER_RE.test(this.cfg.owner)) throw new Error('HUB_OWNER: wallet address from the Sensmos app (0x…) or empty');
        fs.mkdirSync(this.cfg.data, { recursive: true });
        // Bez HUB_OWNER Hub czeka na przypisanie z apki (POST /node/owner po LAN z PIN-em) i pamięta je w owner.json.
        this.ownerFile = path.join(this.cfg.data, 'owner.json');
        this.ownerFromApp = false;
        if (!this.cfg.owner) { try { const o = JSON.parse(fs.readFileSync(this.ownerFile, 'utf8')).owner; if (OWNER_RE.test(o || '')) { this.cfg.owner = o; this.ownerFromApp = true; } } catch {} }
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
        // Cudze czujniki LoRaWAN (ABP): ramki z wybranymi DevAddr idą do ChirpStacka/TTN jak z bramy (HUB_LORAWAN_FORWARD + HUB_LORAWAN_DEVADDR).
        this.lorawan = new LoRaWan({ forward: this.cfg.lorawanForward, devaddrs: this.cfg.lorawanDevaddr, deviceId: this.id.id, log: this.log, send: o => this.send(o) });
        this.esphome = new EspHomeLora({ boards: this.cfg.esphomeLora, lora: this.lora, log: this.log, send: o => this.send(o) });
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
        this.lan = lan.start({ port: this.cfg.port, pin: this.pin, identity: this.id, pairing: this.pairing, firmware: FIRMWARE, owner: () => this.cfg.owner || '', onOwner: o => this.setOwner(o),
            sensors: () => this.ha?.snapshot() || null, shared: this.shared = new ha.Shared(this.cfg.data),
            data: () => this.dataView(), lora: this.lora, mesh: { ingest: m => (this.mesh ? this.mesh.ingest(m) : { error: 'no Home Assistant access' }) }, connected: () => !!this.chan, history: this.history = new History(this.cfg.data, { log: this.log }),
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
            // Most Meshtastic (POST /meshtastic) → sensor.meshtastic_* i zdarzenie sensmos_meshtastic_message. HUB_MESHTASTIC=0 wyłącza.
            if (this.cfg.meshtastic !== false) this.mesh = new Meshtastic({ dir: this.cfg.data, cfg: haCfg, log: this.log, track: this.cfg.meshtasticTrack }).start();
        } else this.log('HA: no access to Home Assistant (Docker: HUB_HA_URL + HUB_HA_TOKEN in .env) — sensors off');
        // Udostępnione czujniki co dataS: zapis do historii lokalnej zawsze, wysyłka do sieci gdy jest połączenie
        // (ten sam batch co ESP32, kanał szyfrowany, BE: onBatch → batch.js).
        this.dataT = setInterval(() => this.sendSensors(), (this.cfg.dataS || 300) * 1000);
        this.lorawan.start();
        if (!this.cfg.owner) { this.waitForOwner(haCfg); return this; }
        try { await this.register(); } catch (e) { this.log(e.message); }
        this.connect();
        return this;
    }

    // Hub bez właściciela: nie rejestruje się i nie łączy z siecią, dopóki apka go nie przypisze.
    // W dodatku HA PIN trafia do powiadomienia (do logu dodatku też, tylko na konsolę).
    waitForOwner(haCfg) {
        this.log('no owner yet: in the Sensmos app open Nodes → Add → Search the network and pick this hub (PIN from the add-on notification or log)');
        if (haCfg && this.cfg.notify !== false) ha.notify(haCfg, {
            notification_id: 'sensmos_hub_pin',
            title: 'Sensmos Hub is ready',
            message: `Add it in the Sensmos app: **Nodes → Add → Search the network**, pick this hub and enter PIN **${this.pin}**. No wallet address to type.`,
        }).catch(e => this.log('HA notification:', e.message));
    }

    // Przypisanie z apki (LAN, PIN sprawdzony w lan.js). Ten sam adres = nic do zrobienia; inny, gdy już jest = odmowa.
    async setOwner(addr) {
        if (!OWNER_RE.test(addr || '')) return { code: 400, error: 'owner must be 0x + 40 hex chars' };
        if (this.cfg.owner) {
            if (this.cfg.owner.toLowerCase() === addr.toLowerCase()) return { code: 200, status: 'ok', owner: this.cfg.owner.toLowerCase() };
            return { code: 409, error: 'owner_set' };
        }
        this.cfg.owner = addr;
        try { await this.register(); }
        catch (e) { this.cfg.owner = ''; this.log(e.message); return { code: 502, error: e.message }; }
        fs.writeFileSync(this.ownerFile, JSON.stringify({ owner: addr.toLowerCase(), at: new Date().toISOString() }) + '\n');
        this.ownerFromApp = true;
        this.log(`owner set from the app: ${addr.slice(0, 6)}…${addr.slice(-4)}`);
        const haCfg = this.cfg.ha || ha.config();
        if (haCfg && this.cfg.notify !== false) ha.dismiss(haCfg, 'sensmos_hub_pin').catch(() => {});
        if (!this.ws) this.connect();
        return { code: 200, status: 'ok', owner: addr.toLowerCase() };
    }

    stop() {
        this.stopping = true;
        clearTimeout(this.retryT);
        this.tunnels?.closeAll();
        this.ws?.close();
        this.lan?.close();
        this.ha?.stop();
        this.haLora?.stop();
        this.mesh?.stop();
        this.lorawan?.stop();
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
            try { fs.unlinkSync(this.registeredFile); } catch {}
            // Przypisanie z apki znika razem z nodem: po restarcie Hub znów czeka na apkę (może to być inny portfel).
            if (this.ownerFromApp) { try { fs.unlinkSync(this.ownerFile); } catch {} }
            this.log(this.ownerFromApp
                ? 'the node was removed from the account in the app. Stopping; restart the hub and add it again from the app.'
                : 'the node was removed from the account in the app. Stopping; to add it again, start the hub again.');
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
        this.lorawan.claim();
        this.esphome.claim();
        this.emit('connected');
    }

    sendSensors() {
        if (!this.ha || this.ha.error) return 0;   // HA niedostępny: nie udajemy świeżych odczytów
        const entities = ha.toEntities(this.ha.sensors, id => this.shared?.has(id), this.outdoor ||= ha.outdoorRule(this.cfg.outdoor));
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

    // Potwierdzenie Huba bez apki (0.2.0-beta8): sensmos.com/my w telefonie w tej samej sieci prosi BE, a BE
    // przekazuje prośbę tym kanałem. Hub podpisuje ten sam atest co w LAN /attest, ale tylko z poprawnym PIN-em
    // (wpisanym przez właściciela na stronie). 5 złych PIN-ów = 15 min blokady. BE i tak sprawdza jeszcze
    // podpis portfela właściciela i to, że telefon wychodzi do internetu z tego samego adresu co Hub.
    onAttestReq(m) {
        const rid = String(m.rid || '');
        if (!/^[0-9a-f]{16,64}$/.test(rid)) return;
        const reply = o => this.send({ type: 'attest_res', rid, ...o });
        const now = Date.now();
        if (this.attLockUntil && now < this.attLockUntil) return reply({ error: 'too_many_attempts' });
        const pin = Buffer.from(String(m.pin || '')), mine = Buffer.from(String(this.pin));
        if (pin.length !== mine.length || !crypto.timingSafeEqual(pin, mine)) {
            this.attFails = (this.attFails || 0) + 1;
            if (this.attFails >= 5) { this.attFails = 0; this.attLockUntil = now + 15 * 60e3; }
            this.log('confirmation from sensmos.com/my: wrong PIN');
            return reply({ error: 'bad_pin' });
        }
        this.attFails = 0;
        if (!this.cfg.owner) return reply({ error: 'no_owner' });
        const bad = hubAttest.check(m.seed, m.gps_lat, m.gps_lon);
        if (bad) return reply({ error: bad });
        const attest = hubAttest.build(this.id.id, this.cfg.owner, m.seed, String(m.gps_lat), String(m.gps_lon));
        this.log('confirmation from sensmos.com/my: attestation signed (hub rewards)');
        return reply({ attest, sig: this.id.sign(attest) });
    }

    handle(m) {
        this.emit('message', m);
        if (this.debug && m.type !== 'check_jobs') this.log('BE →', m.type);
        switch (m.type) {
            case 'check_jobs':
                measure.run(m.jobs).then(recs => { if (recs.length) { this.send({ type: 'measure', v: 1, m: recs }); this.log(`measure: ${recs.length} records`); } });
                return;
            case 'tun_open': return this.tunnels.onOpen(m);
            case 'lora_frame': this.lora.onWs(m.hex, undefined, m); return;
            case 'lorawan_frame': this.lorawan.onWs(m); return;
            case 'lorawan_claimed': this.log(`LoRaWAN: the network delivers ${m.n} DevAddr to this hub`); return;
            case 'esphome_frame': this.esphome.onWs(m); return;
            case 'esphome_claimed': this.log(`ESPHome LoRa: the network delivers frames of ${m.n} board(s) to this hub`); return;
            case 'lora_frame_tx':
                // BE prosi bazę o nadanie radiem do jej czujnika — Hub radia nie ma.
                if (!this.seen.has(m.type)) { this.seen.add(m.type); this.log('LoRa: frame to transmit by radio refused (the hub has no radio)'); }
                return;
            case 'tun_close': return this.tunnels.onClose(m);
            case 'reboot': this.log('backend asks for a restart; reconnecting'); return this.ws.close();
            case 'deleted': return this.onIdentified({ status: 'deleted' });
            case 'ota': this.log('OTA does not apply to the hub (update = new Docker image)'); return;
            case 'message': this.log('message:', JSON.stringify(m).slice(0, 200)); return;
            case 'attest_req': return this.onAttestReq(m);
            default:
                if (this.debug) this.log('BE →', m.type, JSON.stringify(m).slice(0, 300));
                else if (!QUIET.has(m.type) && !this.seen.has(m.type)) { this.seen.add(m.type); this.log('unhandled type from backend:', m.type); }
        }
    }
}

module.exports = { Hub, FIRMWARE, diag };
