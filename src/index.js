#!/usr/bin/env node
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
const BE_PUB = require('./be_pub');

const FIRMWARE = 'hub-' + require('../package.json').version;
const cfg = {
    be: (process.env.HUB_BE || 'https://sensmos.com').replace(/\/$/, ''),
    owner: (process.env.HUB_OWNER || '').trim(),
    data: process.env.HUB_DATA || path.join(__dirname, '..', 'data'),
    port: parseInt(process.env.HUB_PORT) || 8080,
    bePub: process.env.HUB_BE_PUB || BE_PUB,
    pingS: 30,
    checkS: 600,
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.owner)) {
    console.error('HUB_OWNER: podaj adres portfela z apki Sensmos (0x…), np. HUB_OWNER=0x1234… w pliku .env');
    process.exit(2);
}
fs.mkdirSync(cfg.data, { recursive: true });
const id = identity.load(cfg.data);
const pairing = new Pairing(cfg.data);
const pin = loadPin();
const registeredFile = path.join(cfg.data, 'registered.json');

function loadPin() {
    if (/^\d{6}$/.test(process.env.HUB_PIN || '')) return process.env.HUB_PIN;
    const f = path.join(cfg.data, 'pin.txt');
    try { const p = fs.readFileSync(f, 'utf8').trim(); if (/^\d{6}$/.test(p)) return p; } catch {}
    const p = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    fs.writeFileSync(f, p + '\n', { mode: 0o600 });
    return p;
}

async function register() {
    try {
        const r = JSON.parse(fs.readFileSync(registeredFile, 'utf8'));
        if (r.owner === cfg.owner.toLowerCase() && r.be === cfg.be) return;
    } catch {}
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = JSON.stringify({ device_id: id.id, owner: cfg.owner, nonce, ts: Math.floor(Date.now() / 1000) });
    const sig_esp = id.sign(message);
    const body = { message, pubkey: id.pubHex, sig_esp, proof: crypto.createHash('sha256').update(nonce + sig_esp + id.id).digest('hex') };
    const r = await fetch(`${cfg.be}/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (r.status === 403) throw new Error('ten hub jest już przypisany do innego portfela. Nowa tożsamość: usuń plik identity.json z katalogu danych.');
    if (!r.ok) throw new Error(`rejestracja w BE nieudana (${r.status}): ${txt}`);
    fs.writeFileSync(registeredFile, JSON.stringify({ owner: cfg.owner.toLowerCase(), be: cfg.be, at: new Date().toISOString() }) + '\n');
    log('zarejestrowany w BE; nod pojawi się w apce na liście nodów tego portfela');
}

let ws = null, chan = null, tunnels = null, hubNonce = null, pingT = null, checkT = null, backoffS = 5, stopping = false;

const send = obj => { if (chan && ws?.readyState === WebSocket.OPEN) ws.send(chan.sealJson(obj)); };
const sendTun = (tid, frame) => { if (chan && ws?.readyState === WebSocket.OPEN) ws.send(chan.sealTun(tid, frame)); };

function connect() {
    hubNonce = crypto.randomBytes(16);
    chan = null;
    tunnels = new Tunnels({ pairing, deviceId: id.id, send, sendTun, log });
    ws = new WebSocket(cfg.be.replace(/^http/, 'ws') + '/v1/ws');
    ws.on('open', () => {
        const ts = Math.floor(Date.now() / 1000);
        const msg = `identify:${id.id}:${ts}:e1:${hubNonce.toString('hex')}`;
        ws.send(JSON.stringify({
            type: 'identify', device_id: id.id, timestamp: ts, msg, signature: id.sign(msg),
            enc: 1, enonce: hubNonce.toString('hex'), firmware: FIRMWARE, proto: 2,
            ...(pairing.has() ? { remote: 1 } : {}),
            chip: `hub ${os.platform()}-${os.arch()} node${process.versions.node}`,
        }));
    });
    ws.on('message', (data, isBinary) => {
        if (!isBinary) {
            let m; try { m = JSON.parse(data.toString()); } catch { return; }
            if (m.type === 'identified') return onIdentified(m);
            if (m.type === 'error') {
                log('BE:', m.msg);
                if (m.msg === 'device not registered') { try { fs.unlinkSync(registeredFile); } catch {} }
                if (m.msg === 'update_required') log(`BE wymaga proto ≥ ${m.proto_min}; zaktualizuj hub`);
            }
            return;
        }
        if (!chan) return;
        const r = chan.open(Buffer.from(data));
        if (!r) return;
        if (r.ver === VER_TUN) { if (r.plaintext.length > 2) tunnels.onFrame(r.plaintext.readUInt16BE(0), r.plaintext.subarray(2)); return; }
        let m; try { m = JSON.parse(r.plaintext.toString('utf8')); } catch { return; }
        handle(m);
    });
    ws.on('error', e => log('WS:', e.message));
    ws.on('close', () => {
        clearInterval(pingT); clearInterval(checkT);
        tunnels?.closeAll();
        chan = null;
        if (stopping) return;
        log(`rozłączony; ponowna próba za ${backoffS} s`);
        setTimeout(() => { register().then(connect).catch(e => { log(e.message); setTimeout(connect, backoffS * 1000); }); }, backoffS * 1000);
        backoffS = Math.min(backoffS * 2, 120);
    });
}

function onIdentified(m) {
    if (m.status === 'deleted') {
        log('nod został usunięty z konta w apce. Zatrzymuję się; żeby dodać go ponownie, uruchom hub jeszcze raz.');
        try { fs.unlinkSync(registeredFile); } catch {}
        stopping = true; ws.close(); process.exitCode = 0;
        return;
    }
    if (!m.enonce) { log('BE nie otworzył kanału szyfrowanego'); ws.close(); return; }
    chan = new Channel(id.ecdh, Buffer.from(cfg.bePub, 'hex'), hubNonce, Buffer.from(m.enonce, 'hex'));
    backoffS = 5;
    log(`połączony z ${cfg.be} jako ${id.id.slice(0, 16)}… (${FIRMWARE}${pairing.has() ? ', sparowany' : ', niesparowany'})`);
    ping();
    pingT = setInterval(ping, cfg.pingS * 1000);
    send({ type: 'check_assign' });
    checkT = setInterval(() => send({ type: 'check_assign' }), cfg.checkS * 1000);
}

function ping() {
    const free = Math.min(os.freemem(), 2147483647);
    send({ type: 'ping', device_id: id.id, free, largest: free });
}

const quiet = new Set(['tasks_update', 'tasks_clear', 'config_ack', 'batch_ack', 'monitor_set', 'monitor_clear', 'check_config', 'subscription_push', 'lora_msg_seed', 'fw_digest', 'pong']);
const seen = new Set();
function handle(m) {
    switch (m.type) {
        case 'check_jobs':
            measure.run(m.jobs).then(recs => { if (recs.length) { send({ type: 'measure', v: 1, m: recs }); log(`measure: ${recs.length} rekordów`); } });
            return;
        case 'tun_open': return tunnels.onOpen(m);
        case 'tun_close': return tunnels.onClose(m);
        case 'reboot': log('BE prosi o restart; łączę ponownie'); return ws.close();
        case 'deleted': return onIdentified({ status: 'deleted' });
        case 'ota': log('OTA nie dotyczy hubu (aktualizacja = nowy obraz Dockera)'); return;
        case 'message': log('wiadomość:', JSON.stringify(m).slice(0, 200)); return;
        default:
            if (!quiet.has(m.type) && !seen.has(m.type)) { seen.add(m.type); log('nieobsługiwany typ z BE:', m.type); }
    }
}

(async () => {
    log(`Sensmos Hub ${FIRMWARE} — device_id ${id.id}`);
    log(`PIN hubu: ${pin} (apka pyta o niego przy parowaniu i eksporcie)`);
    lan.start({ port: cfg.port, pin, identity: id, pairing, firmware: FIRMWARE, log, onPairingChange: () => ws?.close() });
    try { await register(); } catch (e) { log(e.message); }
    connect();
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; tunnels?.closeAll(); ws?.close(); setTimeout(() => process.exit(0), 300); });
