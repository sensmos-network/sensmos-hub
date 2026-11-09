// E2E z atrapą BE w procesie: rejestracja → identify → kanał szyfrowany → check_jobs/measure →
// parowanie po LAN → tun_open z dowodem → ramki tunelu w obie strony → tun_close.
// Klucze BE z wektora ws-enc.json (be_priv), więc hub dostaje bePub z tego samego wektora.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Hub } = require('../src/hub');
const { Channel, VER_JSON, VER_TUN } = require('../src/wsenc');
const { Session } = require('../src/tunnel');
const lora = require('../src/lora');

const W = process.env.SENSMOS_WEKTORY || path.join(__dirname, '..', '..', 'kontrakt', 'protokol', 'wektory');
const V = JSON.parse(fs.readFileSync(path.join(W, 'ws-enc.json'), 'utf8'));
const SPKI = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
const OWNER = '0x5Cb314D83f0b15ACa87cAeA920f242A4D19a3Dd0';

function waiter() {
    const q = [], waiting = [];
    return {
        push: x => { const w = waiting.shift(); w ? w(x) : q.push(x); },
        next: (ms = 5000) => q.length ? Promise.resolve(q.shift()) : new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timeout')), ms);
            waiting.push(x => { clearTimeout(t); res(x); });
        }),
    };
}

// Atrapa BE: POST /v1/register + WS /v1/ws z kanałem szyfrowanym po stronie serwera.
function fakeBe() {
    const beEcdh = crypto.createECDH('secp256k1');
    beEcdh.setPrivateKey(Buffer.from(V.be_priv, 'hex'));
    const devices = new Map();
    const srv = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/register') {
            let b = ''; req.on('data', c => b += c); req.on('end', () => {
                const j = JSON.parse(b); const m = JSON.parse(j.message);
                const key = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(j.pubkey, 'hex')]), format: 'der', type: 'spki' });
                const ok = crypto.createVerify('SHA256').update(j.message).verify(key, Buffer.from(j.sig_esp, 'hex'));
                if (!ok) { res.writeHead(401); return res.end('{"error":"invalid esp signature"}'); }
                devices.set(m.device_id, { pub: Buffer.from(j.pubkey, 'hex'), owner: m.owner });
                res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' }));
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    const wss = new WebSocket.Server({ server: srv, path: '/v1/ws' });
    const be = { srv, devices, json: waiter(), tun: waiter(), node: null, chan: null, identify: null };
    wss.on('connection', ws => {
        ws.on('message', (data, isBinary) => {
            if (!isBinary) {
                const m = JSON.parse(data.toString());
                if (m.type !== 'identify') return;
                const d = devices.get(m.device_id);
                const key = crypto.createPublicKey({ key: Buffer.concat([SPKI, d.pub]), format: 'der', type: 'spki' });
                assert.ok(crypto.createVerify('SHA256').update(m.msg).verify(key, Buffer.from(m.signature, 'hex')), 'podpis identify');
                be.identify = m;
                const beNonce = crypto.randomBytes(16);
                be.chan = new Channel(beEcdh, d.pub, Buffer.from(m.enonce, 'hex'), beNonce);
                [be.chan.tx, be.chan.rx] = [be.chan.rx, be.chan.tx];
                be.node = ws;
                ws.send(JSON.stringify({ type: 'identified', status: 'ok', device_id: m.device_id, enonce: beNonce.toString('hex') }));
                return;
            }
            const r = be.chan.open(Buffer.from(data));
            assert.ok(r, 'ramka od hubu otwiera się');
            if (r.ver === VER_JSON) be.json.push(JSON.parse(r.plaintext.toString()));
            else be.tun.push({ tid: r.plaintext.readUInt16BE(0), frame: r.plaintext.subarray(2) });
        });
    });
    be.send = obj => be.node.send(be.chan.seal(VER_JSON, Buffer.from(JSON.stringify(obj))));
    be.sendTun = (tid, frame) => be.node.send(be.chan.sealTun(tid, frame));
    be.until = async (type, ms) => { for (;;) { const m = await be.json.next(ms); if (m.type === type) return m; } };
    return new Promise(res => srv.listen(0, '127.0.0.1', () => { be.url = `http://127.0.0.1:${srv.address().port}`; res(be); }));
}

test('E2E: rejestracja, kanał, measure, parowanie, tunel', async () => {
    const be = await fakeBe();
    const lanSrv = net.createServer(s => s.on('data', d => { s.end('HELLO ' + d.toString().trim()); }));
    await new Promise(r => lanSrv.listen(0, '127.0.0.1', r));
    const lanPort = lanSrv.address().port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-e2e-'));
    const logs = [];
    const hub = new Hub({ be: be.url, owner: OWNER, data: dir, port: 0, bePub: V.be_pub, pin: '123456', pingS: 3600, checkS: 3600, backoffS: 0.2, mdns: false, log: (...a) => logs.push(a.join(' ')) });
    try {
        await hub.start();
        assert.ok(fs.existsSync(path.join(dir, 'registered.json')), 'rejestracja zapisana');
        assert.strictEqual(be.devices.get(hub.id.id).owner, OWNER);
        await new Promise((res, rej) => { hub.on('connected', res); setTimeout(() => rej(new Error('brak connected')), 5000); });
        assert.strictEqual(be.identify.proto, 2);
        assert.match(be.identify.firmware, /^hub-/);
        assert.strictEqual(be.identify.remote, undefined, 'niesparowany → bez remote');
        const ping = await be.until('ping');
        assert.strictEqual(ping.device_id, hub.id.id);
        await be.until('check_assign');

        // pomiar: job tcp do lokalnego serwera
        be.send({ type: 'check_jobs', jobs: [{ id: 0, kind: 'tcp', host: '127.0.0.1', port: lanPort, target_kind: 'target', to_region: 'EU', to_lat: 52.2, to_lon: 21.0 }] });
        const meas = await be.until('measure');
        assert.strictEqual(meas.v, 1);
        assert.strictEqual(meas.m.length, 1);
        assert.strictEqual(meas.m[0].kind, 'net.tcp');
        assert.strictEqual(meas.m[0].ok, true);
        assert.deepStrictEqual(meas.m[0].x, { to_region: 'EU', to_lat: 52.2, to_lon: 21.0 });

        // tun_open bez parowania → error
        be.send({ type: 'tun_open', tid: 1, ip: '127.0.0.1', port: lanPort, ts: Math.floor(Date.now() / 1000), proof: 'ab'.repeat(32), v: 2 });
        let st = await be.until('tun_state');
        assert.deepStrictEqual(st, { type: 'tun_state', tid: 1, st: 'error', msg: 'node not paired' });

        // parowanie po LAN (jak apka: Bearer PIN + klucz) → hub łączy się ponownie z remote:1
        const lanPortHub = hub.lan.address().port;
        const pairKey = crypto.randomBytes(32);
        const reconnected = new Promise(res => hub.on('connected', res));
        const pr = await fetch(`http://127.0.0.1:${lanPortHub}/node/pair`, { method: 'POST', headers: { Authorization: 'Bearer 123456', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: pairKey.toString('hex') }) });
        assert.deepStrictEqual(await pr.json(), { status: 'ok', keys: 1 });
        await reconnected;
        assert.strictEqual(be.identify.remote, 1, 'po parowaniu identify niesie remote:1');
        await be.until('check_assign');

        // tun_open z dowodem jak w apce
        const ts = Math.floor(Date.now() / 1000);
        const proof = crypto.createHmac('sha256', pairKey).update(`sensmos-tun-open|${hub.id.id}|127.0.0.1|${lanPort}|${ts}`).digest('hex');
        be.send({ type: 'tun_open', tid: 7, ip: '127.0.0.1', port: lanPort, ts, proof, v: 2 });
        st = await be.until('tun_state');
        assert.deepStrictEqual(st, { type: 'tun_state', tid: 7, st: 'open', msg: 'connected' });

        // ramka apka → nod → LAN; odpowiedź LAN → nod → apka
        const app = new Session(pairKey, ts);
        be.sendTun(7, app.seal(Buffer.from('ping-from-app'), undefined, 1));
        const back = await be.tun.next();
        assert.strictEqual(back.tid, 7);
        assert.strictEqual(app.open(back.frame, 0).toString(), 'HELLO ping-from-app');
        st = await be.until('tun_state');
        assert.strictEqual(st.st, 'closed');

        // powtórzony dowód → odrzucony
        be.send({ type: 'tun_open', tid: 8, ip: '127.0.0.1', port: lanPort, ts, proof, v: 2 });
        st = await be.until('tun_state');
        assert.deepStrictEqual(st, { type: 'tun_state', tid: 8, st: 'error', msg: 'proof replayed' });

        // adres publiczny → odrzucony
        const ts2 = ts + 1;
        const proof2 = crypto.createHmac('sha256', pairKey).update(`sensmos-tun-open|${hub.id.id}|8.8.8.8|53|${ts2}`).digest('hex');
        be.send({ type: 'tun_open', tid: 9, ip: '8.8.8.8', port: 53, ts: ts2, proof: proof2, v: 2 });
        st = await be.until('tun_state');
        assert.strictEqual(st.msg, 'only private LAN addresses allowed');

        // czujniki z HA: bez wyboru nic nie idzie; po wyborze batch z natywną encją i own.* (kanałem szyfrowanym)
        hub.ha = { sensors: [
            { entity_id: 'sensor.salon_t', value: 21.4, unit: '°C', device_class: 'temperature', updated: '2026-11-08T10:00:00Z' },
            { entity_id: 'sensor.kuchnia_t', value: 19.0, unit: '°C', device_class: 'temperature' },
            { entity_id: 'binary_sensor.drzwi', value: true, device_class: 'door' },
            { entity_id: 'sensor.prywatny', value: 5, unit: 'x' } ], stop() {} };
        assert.strictEqual(hub.sendSensors(), 0, 'domyślnie nic nie jest udostępniane');
        hub.shared.set(['sensor.salon_t', 'sensor.kuchnia_t', 'binary_sensor.drzwi']);
        assert.strictEqual(hub.sendSensors(), 3);
        const b = await be.until('batch');
        assert.strictEqual(b.device_id, hub.id.id);
        assert.deepStrictEqual(b.entities.map(e => [e.entity_id, e.value]).sort(), [['own.ha_s_kuchnia_t', 19], ['pub.door', 1], ['pub.temp_in', 21.4]]);
        assert.ok(!b.entities.some(e => /prywatny/.test(e.entity_id)), 'niezaznaczony czujnik nie wychodzi');
        const view = hub.dataView();
        assert.deepStrictEqual(view.status.pub.map(e => e.entity_id).sort(), ['pub.door', 'pub.temp_in']);
        assert.deepStrictEqual(view.status.own.map(e => e.entity_id), ['own.ha_s_kuchnia_t']);
        assert.strictEqual(view.native.entities.find(e => e.entity_id === 'temp_in').value, '21.4');
        assert.strictEqual(hub.history.query({ hours: 1 }).length, 3, 'wysłane odczyty są też w historii lokalnej');

        // LoRa: czujnik nadaje do Hubu (dst = id8), obcy nod słyszy, BE dowozi hex po WS → Hub dekoduje, kwit bez treści
        const H = { Authorization: 'Bearer 123456', 'Content-Type': 'application/json' };
        await fetch(`http://127.0.0.1:${lanPortHub}/node/lora_rx`, { method: 'POST', headers: H, body: JSON.stringify({ key: 'fraza e2e' }) });
        be.send({ type: 'lora_frame', hex: lora.encode(hub.id.id.slice(0, 8), 3, 't=21.5;bat=90', lora.keyFromPhrase('fraza e2e')) });
        const rc = await be.until('lora_data_rcpt');
        assert.deepStrictEqual([rc.sub, rc.via, rc.len, rc.enc], [3, 'ws', 13, true]);
        const inbox = await (await fetch(`http://127.0.0.1:${lanPortHub}/lora/inbox`, { headers: H })).json();
        assert.strictEqual(inbox.frames.items[0].text, 't=21.5;bat=90');
        const lsend = await (await fetch(`http://127.0.0.1:${lanPortHub}/node/lorasend`, { method: 'POST', headers: H, body: JSON.stringify({ dst: '0badc0de', sub: 1, payload: 'on' }) })).json();
        assert.deepStrictEqual(lsend, { status: 'sent_ws' });
        const ls = await be.until('lora_send');
        assert.deepStrictEqual([ls.dst, ls.sub, lora.decode(ls.hex, '0badc0de', null, true).payload.toString()], ['0badc0de', 1, 'on']);
    } finally {
        hub.stop();
        lanSrv.close();
        be.srv.close();
        await new Promise(r => setTimeout(r, 100));
    }
});
