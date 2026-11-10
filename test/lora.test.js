// Ramki DATA 0x02 w Hubie: dekod jak FW/integracja HA, kwit, powtórki, stan na dysku, czujniki w HA, LAN API.
// Wektory „py” policzone niezależnie przez lora_frame.py z integracji Sensmos dla HA (port FW data_rx_process).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const L = require('../src/lora');
const { HaLora, toStates } = require('../src/ha_lora');
const lan = require('../src/lan');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lora-'));
const DEV = 'a1b2c3d4' + 'e5'.repeat(28);
const V_AES = 'e00201a1b2c3d40301020304310b8755aabc72dd85221c4d2af00b';   // „fraza testowa”, sub 3, „t=21.5;h=40”
const V_OPEN = 'e00200a1b2c3d40068656c6c6f86a61036';                        // jawna, sub 0, „hello”
const V_PY = 'e002010badc0de07deadbeef64f14c0ddbdee2';                       // z Pythona: „zażółć”, sub 7, 01 02 ff

test('dekod: wektory zgodne z integracją HA (AES, jawna, binarna)', () => {
    let f = L.decode(V_AES, 'a1b2c3d4', L.keyFromPhrase('fraza testowa'), false);
    assert.deepStrictEqual([f.sub, f.enc, f.payload.toString(), f.crc, f.fh], [3, true, 't=21.5;h=40', 2747733406, 1238939481]);
    f = L.decode(V_OPEN, 'a1b2c3d4', null, true);
    assert.deepStrictEqual([f.sub, f.enc, f.payload.toString(), f.crc, f.fh], [0, false, 'hello', 907060870, 3430947180]);
    f = L.decode(V_PY, '0badc0de', L.keyFromPhrase('zażółć'), false);
    assert.deepStrictEqual([f.sub, f.payload.toString('hex')], [7, '0102ff']);
    assert.strictEqual(L.encode('a1b2c3d4', 3, 't=21.5;h=40', L.keyFromPhrase('fraza testowa'), Buffer.from('01020304', 'hex')), V_AES);
    assert.strictEqual(L.encode('a1b2c3d4', 0, 'hello'), V_OPEN);
});

test('dekod: odrzucenia', () => {
    assert.strictEqual(L.decode(V_AES, 'a1b2c3d4', L.keyFromPhrase('inna'), false).err, 'crc_key');
    assert.strictEqual(L.decode(V_AES, 'a1b2c3d4', null, true).err, 'no_key');
    assert.strictEqual(L.decode(V_OPEN, 'a1b2c3d4', null, false).err, 'open_off', 'jawne tylko po zgodzie, jak w FW');
    assert.strictEqual(L.decode(V_OPEN, 'ffffffff', null, true).err, 'dst');
    assert.strictEqual(L.decode('e004' + V_OPEN.slice(4), 'a1b2c3d4', null, true).err, 'type');
    assert.strictEqual(L.decode('zz', 'a1b2c3d4', null, true).err, 'format');
    const bad = V_OPEN.slice(0, -2) + '00';
    assert.strictEqual(L.decode(bad, 'a1b2c3d4', null, true).err, 'crc');
});

test('Lora: kwit, powtórka, ring, stan na dysku bez frazy', () => {
    const dir = tmp(), sent = [], logs = [];
    const lo = new L.Lora({ dir, deviceId: DEV, log: m => logs.push(m), send: o => sent.push(o) });
    assert.strictEqual(lo.onWs(V_AES, 1000), null, 'bez klucza nic');
    assert.ok(logs.some(l => /has no key/.test(l)));
    lo.configure({ key: 'fraza testowa' });
    const it = lo.onWs(V_AES, 1001);
    assert.deepStrictEqual(it, { ts: 1001, sub: 3, enc: true, via: 'ws', text: 't=21.5;h=40' });
    assert.deepStrictEqual(sent, [{ type: 'lora_data_rcpt', sub: 3, via: 'ws', len: 11, enc: true, fh: 1238939481 }]);
    assert.strictEqual(lo.onWs(V_AES, 1050), null, 'ta sama ramka od drugiego słyszącego = powtórka');
    assert.strictEqual(sent.length, 1);
    assert.ok(lo.onWs(V_AES, 1200), 'po 120 s to nowy odczyt');
    assert.ok(!logs.some(l => l.includes('21.5')), 'treść nie trafia do logu (paczka diag)');
    lo.configure({ open: true });
    for (let i = 0; i < 8; i++) lo.onWs(L.encode(DEV.slice(0, 8), 10 + i, 'v=' + i), 2000 + i);
    assert.strictEqual(lo.inbox().frames.count, L.RING);
    const raw = fs.readFileSync(path.join(dir, 'lora.json'), 'utf8');
    assert.ok(!raw.includes('fraza testowa'), 'fraza nie jest zapisywana, tylko SHA256');
    const again = new L.Lora({ dir, deviceId: DEV });
    assert.deepStrictEqual(again.state(), { key_set: true, open: true });
    assert.strictEqual(again.last['3'].text, 't=21.5;h=40');
    assert.strictEqual(again.inbox().frames.items.length, L.RING);
});

test('Lora: nadanie przez sieć (lorasend)', () => {
    const sent = [];
    const lo = new L.Lora({ dir: tmp(), deviceId: DEV, send: o => sent.push(o) });
    assert.deepStrictEqual(lo.sendData({ dst: DEV.slice(0, 8), payload: 'x' }, true), { error: 'no radio' });
    assert.deepStrictEqual(lo.sendData({ dst: '0badc0de', payload: 'x', aes: true }, true), { error: 'aes without rx key' });
    assert.deepStrictEqual(lo.sendData({ dst: '0badc0de', payload: 'x' }, false), { error: 'no uplink (ws) for send' });
    assert.deepStrictEqual(lo.sendData({ dst: 'xyz', payload: 'x' }, true), { error: 'bad dst (8 hex)' });
    lo.configure({ key: 'k' });
    assert.deepStrictEqual(lo.sendData({ dst: '0BADC0DE', sub: 2, payload: 'on', aes: true }, true), { status: 'sent_ws' });
    assert.strictEqual(sent[0].type, 'lora_send');
    assert.strictEqual(sent[0].dst, '0badc0de');
    const f = L.decode(sent[0].hex, '0badc0de', L.keyFromPhrase('k'), false);
    assert.deepStrictEqual([f.sub, f.payload.toString()], [2, 'on']);
});

test('toStates: klucz=wartość, liczba, tekst, hex', () => {
    const s = toStates({ ts: 5, sub: 3, enc: true, via: 'ws', text: 't=21.5;h=40;bat=87;mode=eco' }, { id8: 'a1b2c3d4' });
    const by = Object.fromEntries(s.map(x => [x.entity_id, x]));
    assert.strictEqual(by['sensor.sensmos_lora_3'].state, 't=21.5;h=40;bat=87;mode=eco');
    assert.deepStrictEqual([by['sensor.sensmos_lora_3_t'].state, by['sensor.sensmos_lora_3_t'].attributes.unit_of_measurement, by['sensor.sensmos_lora_3_t'].attributes.device_class], [21.5, '°C', 'temperature']);
    assert.strictEqual(by['sensor.sensmos_lora_3_h'].attributes.unit_of_measurement, '%');
    assert.strictEqual(by['sensor.sensmos_lora_3_bat'].attributes.device_class, 'battery');
    assert.strictEqual(by['sensor.sensmos_lora_3_mode'].state, 'eco');
    assert.strictEqual(by['sensor.sensmos_lora_3_mode'].attributes.unit_of_measurement, undefined);
    const n = toStates({ sub: 0, text: '-3.25' });
    assert.deepStrictEqual([n.length, n[0].entity_id, n[0].state, n[0].attributes.state_class], [1, 'sensor.sensmos_lora_0', -3.25, 'measurement']);
    const t = toStates({ sub: 1, text: 'drzwi otwarte' });
    assert.deepStrictEqual([t.length, t[0].state], [1, 'drzwi otwarte'], 'zwykły tekst = jeden czujnik');
    const h = toStates({ sub: 2, hex: '0102ff' });
    assert.deepStrictEqual([h.length, h[0].state, h[0].attributes.hex], [1, '0102ff', '0102ff']);
});

// Atrapa REST API HA: zapisuje POST-y /api/states/* i /api/events/*.
function fakeHa(token = 'tok') {
    const got = [];
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
            if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
            got.push({ path: req.url, body: JSON.parse(b || '{}') });
            res.writeHead(req.url.startsWith('/api/states/') ? 201 : 200, { 'content-type': 'application/json' }); res.end('{}');
        });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, got, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('HaLora: nowa ramka → stany i zdarzenie w HA, odnowienie po restarcie HA', async () => {
    const ha = await fakeHa();
    const logs = [];
    const lo = new L.Lora({ dir: tmp(), deviceId: DEV, log: m => logs.push(m) });
    lo.configure({ key: 'fraza testowa' });
    const hl = new HaLora({ cfg: { url: ha.url, token: 'tok' }, lora: lo, log: m => logs.push(m), everyS: 3600 }).start();
    try {
        lo.onWs(V_AES, 1001);
        await new Promise(r => setTimeout(r, 200));
        const paths = ha.got.map(g => g.path);
        assert.deepStrictEqual(paths, ['/api/states/sensor.sensmos_lora_3', '/api/states/sensor.sensmos_lora_3_t', '/api/states/sensor.sensmos_lora_3_h', '/api/events/sensmos_lora_frame']);
        assert.strictEqual(ha.got[1].body.state, 21.5);
        assert.deepStrictEqual(ha.got[3].body, { node_id: DEV, sub: 3, text: 't=21.5;h=40', hex: null, enc: true, via: 'ws', ts: 1001 });
        ha.got.length = 0;
        assert.strictEqual(await hl.refresh(1001 + 3600), true);
        assert.deepStrictEqual(ha.got.map(g => g.path), ['/api/states/sensor.sensmos_lora_3', '/api/states/sensor.sensmos_lora_3_t', '/api/states/sensor.sensmos_lora_3_h'], 'odnowienie bez zdarzenia');
        ha.got.length = 0;
        await hl.refresh(1001 + 8 * 86400);
        assert.strictEqual(ha.got.length, 0, 'czujnik milczący > 7 dni nie jest odnawiany');
        const bad = new HaLora({ cfg: { url: ha.url, token: 'zly' }, lora: lo, log: m => logs.push(m) });
        assert.strictEqual(await bad.refresh(1001), false);
        assert.ok(logs.some(l => /rejected the token \(401\)/.test(l)));
    } finally { hl.stop(); ha.srv.close(); }
});

test('LAN: /info.lora, /node/lora_rx, /lora/inbox, /node/lorasend, /node/lora_emerg', async () => {
    const dir = tmp(), sent = [];
    const lo = new L.Lora({ dir, deviceId: DEV, send: o => sent.push(o) });
    const identity = { id: DEV, pubHex: '04' + 'ab'.repeat(64) };
    const pairing = { has: () => false, count: () => 0 };
    const srv = lan.start({ port: 0, pin: '123456', identity, pairing, firmware: 'hub-test', owner: '0x' + '1'.repeat(40), lora: lo, connected: () => true, log: () => {} });
    await new Promise(r => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const H = { Authorization: 'Bearer 123456', 'Content-Type': 'application/json' };
    try {
        const info = await (await fetch(base + '/info')).json();
        assert.deepStrictEqual(info.lora, { board: 'hub', role: 0, rx_key: false, open: false, radio: false, id8: 'a1b2c3d4' });
        assert.strictEqual((await fetch(base + '/node/lora_rx')).status, 403, 'za PIN-em');
        let r = await (await fetch(base + '/node/lora_rx', { method: 'POST', headers: H, body: JSON.stringify({ key: 'fraza testowa', open: false }) })).json();
        assert.deepStrictEqual(r, { key_set: true, open: false });
        assert.deepStrictEqual(await (await fetch(base + '/node/lora_rx', { headers: H })).json(), { key_set: true, open: false });
        lo.onWs(V_AES, 1001);
        const inbox = await (await fetch(base + '/lora/inbox', { headers: H })).json();
        assert.deepStrictEqual(inbox, { cmds: { count: 0, items: [] }, frames: { count: 1, items: [{ ts: 1001, sub: 3, enc: true, via: 'ws', text: 't=21.5;h=40' }] } });
        const s = await fetch(base + '/node/lorasend', { method: 'POST', headers: H, body: JSON.stringify({ dst: '0badc0de', sub: 1, payload: 'hi', aes: true }) });
        assert.deepStrictEqual([s.status, await s.json()], [200, { status: 'sent_ws' }]);
        assert.strictEqual(sent.at(-1).type, 'lora_send');
        const e = await (await fetch(base + '/node/lora_emerg', { headers: H })).json();
        assert.deepStrictEqual(e, { eids: [], active: false, webhook: '', webhook_get: false });
        r = await (await fetch(base + '/node/lora_rx', { method: 'POST', headers: H, body: JSON.stringify({ key: '' }) })).json();
        assert.strictEqual(r.key_set, false, 'pusty klucz kasuje, jak w FW');
    } finally { srv.close(); }
});
