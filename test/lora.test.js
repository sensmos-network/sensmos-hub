// Ramki DATA 0x02 w Hubie: dekod jak FW/integracja HA, kwit, powtórki, stan na dysku, czujniki w HA, LAN API.
// Wektory „py” policzone niezależnie przez lora_frame.py z integracji Sensmos dla HA (port FW data_rx_process).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const L = require('../src/lora');
const { HaLora, toStates, silentAfter } = require('../src/ha_lora');
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
        assert.deepStrictEqual(paths, ['/api/states/sensor.sensmos_lora_3', '/api/states/sensor.sensmos_lora_3_t', '/api/states/sensor.sensmos_lora_3_h', '/api/states/binary_sensor.sensmos_lora_3_silent', '/api/events/sensmos_lora_frame']);
        assert.strictEqual(ha.got[1].body.state, 21.5);
        assert.strictEqual(ha.got[3].body.state, 'off');
        assert.deepStrictEqual(ha.got[4].body, { node_id: DEV, sub: 3, text: 't=21.5;h=40', hex: null, enc: true, via: 'ws', ts: 1001 });
        ha.got.length = 0;
        assert.strictEqual(await hl.refresh(1001 + 1800), true);
        assert.deepStrictEqual(ha.got.map(g => g.path), ['/api/states/sensor.sensmos_lora_3', '/api/states/sensor.sensmos_lora_3_t', '/api/states/sensor.sensmos_lora_3_h', '/api/states/binary_sensor.sensmos_lora_3_silent'], 'odnowienie bez zdarzenia');
        ha.got.length = 0;
        await hl.refresh(1001 + 8 * 86400);
        assert.strictEqual(ha.got.length, 0, 'czujnik milczący > 7 dni nie jest odnawiany');
        const bad = new HaLora({ cfg: { url: ha.url, token: 'zly' }, lora: lo, log: m => logs.push(m) });
        assert.strictEqual(await bad.refresh(1001), false);
        assert.ok(logs.some(l => /rejected the token \(401\)/.test(l)));
    } finally { hl.stop(); ha.srv.close(); }
});

test('Lora: zwykły odstęp = najdłuższy z ostatnich 8, czujnik na zdarzenia nie milknie po godzinie', () => {
    const lo = new L.Lora({ dir: tmp(), deviceId: DEV });
    lo.configure({ key: 'fraza testowa' });
    const k = L.keyFromPhrase('fraza testowa');
    const f = (n, txt) => L.encode('a1b2c3d4', 8, txt, k, Buffer.from(String(n).padStart(8, '0'), 'hex'));
    const T = 200000;
    lo.onWs(f(1, 'mail=0'), T);
    lo.onWs(f(2, 'mail=0'), T + 12 * 3600);                    // znak życia co 12 h
    lo.onWs(f(3, 'mail=1'), T + 12 * 3600 + 3600);             // przyszła poczta
    lo.onWs(f(4, 'mail=0'), T + 12 * 3600 + 3900);             // wyjęta 5 min później
    assert.strictEqual(lo.last['8'].gap, 12 * 3600);
    assert.strictEqual(silentAfter(lo.last['8']), 36 * 3600);
    for (let i = 0; i < 9; i++) lo.onWs(f(10 + i, 'mail=0'), T + 14 * 3600 + 120 * (i + 1));
    assert.strictEqual(lo.last['8'].gap, 120, 'po 8 krótkich odstępach dłuższe wypadają');
    assert.strictEqual(lo.last['8'].gaps.length, 8);
});

test('HaLora: czujnik zamilkł → binary_sensor on + jedno zdarzenie; powrót → sensmos_lora_back, także po restarcie Huba', async () => {
    const ha = await fakeHa();
    const dir = tmp();
    const lo = new L.Lora({ dir, deviceId: DEV });
    lo.configure({ key: 'fraza testowa' });
    const hl = new HaLora({ cfg: { url: ha.url, token: 'tok' }, lora: lo, log: () => {}, everyS: 3600 });
    lo.onFrame(it => { hl.onFrame(it); });
    const T = 100000;
    const frame = (t, txt) => L.encode('a1b2c3d4', 3, txt, L.keyFromPhrase('fraza testowa'), Buffer.from(String(t).padStart(8, '0').slice(-8), 'hex'));
    const ev = () => ha.got.filter(g => g.path.startsWith('/api/events/sensmos_lora_s') || g.path.startsWith('/api/events/sensmos_lora_b'));
    const silent = () => ha.got.filter(g => g.path === '/api/states/binary_sensor.sensmos_lora_3_silent').map(g => g.body.state);
    try {
        lo.onWs(frame(1, 'door=0'), T);
        lo.onWs(frame(2, 'door=1'), T + 1200);                 // czujnik co 20 min → cisza po 1 h (minimum)
        await new Promise(r => setTimeout(r, 150));
        assert.strictEqual(lo.last['3'].gap, 1200);
        ha.got.length = 0;
        await hl.refresh(T + 1200 + 3000);
        assert.deepStrictEqual([silent(), ev().length], [['off'], 0], '50 min ciszy to jeszcze nie alarm');
        ha.got.length = 0;
        await hl.refresh(T + 1200 + 3700);
        assert.deepStrictEqual(silent(), ['on']);
        assert.deepStrictEqual(ev().map(e => [e.path, e.body.sub, e.body.silent_s]), [['/api/events/sensmos_lora_silent', 3, 3700]]);
        ha.got.length = 0;
        await hl.refresh(T + 1200 + 7200);
        assert.strictEqual(ev().length, 0, 'jedno zdarzenie na ciszę');
        // restart Huba: znacznik z lora.json, bez drugiego zdarzenia ciszy
        const lo2 = new L.Lora({ dir, deviceId: DEV });
        lo2.configure({ key: 'fraza testowa' });
        const hl2 = new HaLora({ cfg: { url: ha.url, token: 'tok' }, lora: lo2, log: () => {}, everyS: 3600 });
        lo2.onFrame(it => { hl2.onFrame(it); });
        ha.got.length = 0;
        await hl2.refresh(T + 1200 + 9000);
        assert.deepStrictEqual([silent(), ev().length], [['on'], 0]);
        lo2.onWs(frame(3, 'door=0'), T + 1200 + 9600);
        await new Promise(r => setTimeout(r, 150));
        assert.deepStrictEqual(silent(), ['on', 'off']);
        assert.deepStrictEqual(ev().map(e => [e.path, e.body.silent_s]), [['/api/events/sensmos_lora_back', 9600]]);
        assert.strictEqual(silentAfter({ gap: 600 }), 3600);
        assert.strictEqual(silentAfter({ gap: 6 * 3600 }), 18 * 3600);
        assert.strictEqual(silentAfter({ gap: 86400 }), 2 * 86400, 'najwyżej 2 doby');
    } finally { ha.srv.close(); }
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

test('toStates: soil = wilgotność gleby w %, kg = waga (szklarnia, pasieka)', () => {
    const by = Object.fromEntries(toStates({ sub: 10, text: 'soil=34;t=18.5;kg=41.25' }).map(x => [x.entity_id, x.attributes]));
    assert.deepStrictEqual([by['sensor.sensmos_lora_10_soil'].device_class, by['sensor.sensmos_lora_10_soil'].unit_of_measurement], ['moisture', '%']);
    assert.deepStrictEqual([by['sensor.sensmos_lora_10_kg'].device_class, by['sensor.sensmos_lora_10_kg'].unit_of_measurement, by['sensor.sensmos_lora_10_kg'].state_class], ['weight', 'kg', 'measurement']);
});

test('toStates: rain = opad narastająco w mm, wind i gust = wiatr w m/s (stacja pogodowa)', () => {
    const by = Object.fromEntries(toStates({ sub: 19, text: 'rain=12.6;wind=3.4;gust=9.1;t=7.5' }).map(x => [x.entity_id, x.attributes]));
    assert.deepStrictEqual([by['sensor.sensmos_lora_19_rain'].device_class, by['sensor.sensmos_lora_19_rain'].unit_of_measurement, by['sensor.sensmos_lora_19_rain'].state_class], ['precipitation', 'mm', 'total_increasing']);
    assert.deepStrictEqual([by['sensor.sensmos_lora_19_wind'].device_class, by['sensor.sensmos_lora_19_wind'].unit_of_measurement], ['wind_speed', 'm/s']);
    assert.deepStrictEqual([by['sensor.sensmos_lora_19_gust'].device_class, by['sensor.sensmos_lora_19_gust'].state_class], ['wind_speed', 'measurement']);
});

test('toStates: t2 i h2 (druga sonda) mają klasę jak t i h', () => {
    const by = Object.fromEntries(toStates({ sub: 12, text: 't=3.2;t2=-19.5;door=0' }).map(x => [x.entity_id, x.attributes]));
    assert.deepStrictEqual([by['sensor.sensmos_lora_12_t2'].device_class, by['sensor.sensmos_lora_12_t2'].unit_of_measurement], ['temperature', '°C']);
    assert.strictEqual(by['sensor.sensmos_lora_12_door'].device_class, undefined);
});

test('toStates: liczniki (kwh, m3, gas) narastające do panelu Energia, moc chwilowa jako pomiar', () => {
    const s = toStates({ sub: 5, text: 'kwh=1234.567;w=830;m3=56.789;gas=12.3' });
    const by = Object.fromEntries(s.map(x => [x.entity_id, x.attributes]));
    assert.deepStrictEqual([by['sensor.sensmos_lora_5_kwh'].device_class, by['sensor.sensmos_lora_5_kwh'].unit_of_measurement, by['sensor.sensmos_lora_5_kwh'].state_class], ['energy', 'kWh', 'total_increasing']);
    assert.deepStrictEqual([by['sensor.sensmos_lora_5_w'].device_class, by['sensor.sensmos_lora_5_w'].state_class], ['power', 'measurement']);
    assert.deepStrictEqual([by['sensor.sensmos_lora_5_m3'].device_class, by['sensor.sensmos_lora_5_m3'].state_class], ['water', 'total_increasing']);
    assert.strictEqual(by['sensor.sensmos_lora_5_gas'].device_class, 'gas');
    // Stare klucze bez zmian: temperatura dalej pomiar.
    assert.strictEqual(toStates({ sub: 1, text: 't=3' })[1].attributes.state_class, 'measurement');
});

test('gdzie jest mój tag: kto usłyszał ramkę, encja _heard z pozycją dla mapy HA (0.2.0-beta7)', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-heard-'));
    const lo = new L.Lora({ dir, deviceId: DEV, log: () => {}, send: () => {} });
    lo.configure({ open: true });
    const it = lo.onWs(L.encode(DEV.slice(0, 8), 21, 'v=3.9;mv=1'), 5000,
        { rx: 'c0ffee12', rssi: -119, snr: -11.25, near: { lat: 52.23, lon: 21.01 } });
    assert.deepStrictEqual([it.rx, it.rssi, it.snr, it.near], ['c0ffee12', -119, -11.25, { lat: 52.23, lon: 21.01 }]);
    const h = toStates(it).find(s => s.entity_id === 'sensor.sensmos_lora_21_heard');
    assert.equal(h.state, 'c0ffee12');
    assert.deepStrictEqual([h.attributes.latitude, h.attributes.longitude, h.attributes.rssi], [52.23, 21.01, -119]);
    // śmieci z sieci nie trafiają do HA
    const bad = lo.onWs(L.encode(DEV.slice(0, 8), 22, 'v=1'), 6000, { rx: '"><b', near: { lat: 999, lon: 1 } });
    assert.equal(bad.rx, undefined);
    assert.ok(!toStates(bad).some(s => s.entity_id.endsWith('_heard')));
    const nopos = lo.onWs(L.encode(DEV.slice(0, 8), 23, 'v=1'), 7000, { rx: 'c0ffee12', near: { lat: 999, lon: 1 } });
    assert.equal(nopos.near, undefined);
    assert.equal(toStates(nopos).find(s => s.entity_id.endsWith('_heard')).attributes.latitude, undefined);
});

test('toStates: bar = cisnienie w instalacji w barach (kotlownia)', () => {
    const by = Object.fromEntries(toStates({ sub: 23, text: 'bar=1.6;t=55.2;t2=41.0;fault=0' }).map(x => [x.entity_id, x.attributes]));
    assert.deepStrictEqual([by['sensor.sensmos_lora_23_bar'].device_class, by['sensor.sensmos_lora_23_bar'].unit_of_measurement], ['pressure', 'bar']);
    assert.strictEqual(by['sensor.sensmos_lora_23_t2'].device_class, 'temperature');
});
