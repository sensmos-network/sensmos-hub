// Czujniki z HA (temat 1 planu bramy): odczyt stanów, filtr, błędy tokenu, podgląd w LAN z PIN-em.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ha = require('../src/ha');
const lan = require('../src/lan');
const { Pairing } = require('../src/tunnel');

const STATES = [
    { entity_id: 'sensor.salon_temperatura', state: '21.4', attributes: { friendly_name: 'Salon temperatura', unit_of_measurement: '°C', device_class: 'temperature' }, last_updated: '2026-11-08T10:00:00Z' },
    { entity_id: 'sensor.salon_wilgotnosc', state: '48', attributes: { friendly_name: 'Salon wilgotność', unit_of_measurement: '%', device_class: 'humidity' } },
    { entity_id: 'binary_sensor.drzwi', state: 'on', attributes: { friendly_name: 'Drzwi', device_class: 'door' } },
    { entity_id: 'sensor.ups_status', state: 'Online', attributes: {} },               // tekst → odpada
    { entity_id: 'sensor.zepsuty', state: 'unavailable', attributes: {} },            // niedostępny → odpada
    { entity_id: 'light.kuchnia', state: 'on', attributes: {} },                      // nie czujnik → odpada
];

function fakeHa(token = 'tok') {
    const srv = http.createServer((req, res) => {
        if (req.url !== '/api/states') { res.writeHead(404); return res.end(); }
        if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(STATES));
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('config: Docker (URL + token) ma pierwszeństwo, add-on przez SUPERVISOR_TOKEN, bez niczego = null', () => {
    assert.deepStrictEqual(ha.config({ HUB_HA_URL: 'http://ha:8123/', HUB_HA_TOKEN: 't' }), { url: 'http://ha:8123', token: 't', via: 'token' });
    assert.deepStrictEqual(ha.config({ SUPERVISOR_TOKEN: 's' }), { url: 'http://supervisor/core', token: 's', via: 'add-on' });
    assert.strictEqual(ha.config({}), null);
});

test('fetchSensors: tylko sensor/binary_sensor z wartością, liczby jako liczby, jednostki', async () => {
    const { srv, url } = await fakeHa();
    try {
        const list = await ha.fetchSensors({ url, token: 'tok' });
        assert.deepStrictEqual(list.map(s => s.entity_id), ['binary_sensor.drzwi', 'sensor.salon_temperatura', 'sensor.salon_wilgotnosc']);
        const t = list.find(s => s.entity_id === 'sensor.salon_temperatura');
        assert.deepStrictEqual([t.value, t.unit, t.device_class, t.name], [21.4, '°C', 'temperature', 'Salon temperatura']);
        assert.strictEqual(list.find(s => s.entity_id === 'binary_sensor.drzwi').value, true);
        await assert.rejects(ha.fetchSensors({ url, token: 'zly' }), /odrzucił token \(401\)/);
    } finally { srv.close(); }
});

test('HaSensors: log przy pierwszym odczycie i przy błędzie, cisza gdy nic się nie zmienia', async () => {
    const { srv, url } = await fakeHa();
    const logs = [];
    try {
        const h = new ha.HaSensors({ cfg: { url, token: 'tok', via: 'token' }, log: m => logs.push(m) });
        await h.poll(); await h.poll();
        assert.strictEqual(logs.length, 1);
        assert.match(logs[0], /HA \(token\): 3 czujników: binary_sensor\.drzwi=true, sensor\.salon_temperatura=21\.4 °C/);
        h.cfg.token = 'zly'; await h.poll(); await h.poll();
        assert.strictEqual(logs.length, 2);
        assert.match(logs[1], /odrzucił token/);
        assert.strictEqual(h.snapshot().count, 3, 'ostatni dobry odczyt zostaje');
        h.cfg.token = 'tok'; await h.poll();
        assert.strictEqual(logs.length, 3, 'powrót po błędzie jest logowany');
    } finally { srv.close(); }
});

test('LAN /sensors: podgląd tylko z PIN-em; bez dostępu do HA czytelna informacja', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    let snap = null;
    const server = lan.start({ port: 0, pin: '123456', identity: { id: 'ab'.repeat(32), pubHex: '04' }, pairing: new Pairing(dir), firmware: 'hub-test',
        sensors: () => snap, log: () => {} });
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.strictEqual((await fetch(base + '/sensors')).status, 403);
        const none = await (await fetch(base + '/sensors', { headers: { Authorization: 'Bearer 123456' } })).json();
        assert.strictEqual(none.count, 0);
        assert.match(none.error, /no Home Assistant access/);
        snap = { via: 'add-on', count: 1, sensors: [{ entity_id: 'sensor.x', value: 1 }] };
        const j = await (await fetch(base + '/sensors', { headers: { Authorization: 'Bearer 123456' } })).json();
        assert.strictEqual(j.count, 1);
    } finally { server.close(); }
});

test('wybór do udostępnienia: domyślnie żaden, zapis na dysku, tylko poprawne entity_id, LAN z PIN-em', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    const shared = new ha.Shared(dir);
    assert.deepStrictEqual(shared.list(), []);
    const snap = { via: 'add-on', count: 2, sensors: [{ entity_id: 'sensor.a', value: 1 }, { entity_id: 'binary_sensor.b', value: true }] };
    const server = lan.start({ port: 0, pin: '123456', identity: { id: 'ab'.repeat(32), pubHex: '04' }, pairing: new Pairing(dir), firmware: 'hub-test',
        sensors: () => snap, shared, log: () => {} });
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const H = { Authorization: 'Bearer 123456', 'Content-Type': 'application/json' };
    try {
        let j = await (await fetch(base + '/sensors', { headers: H })).json();
        assert.deepStrictEqual(j.sensors.map(s => s.shared), [false, false]);
        assert.strictEqual((await fetch(base + '/sensors/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"shared":[]}' })).status, 403);
        const r = await (await fetch(base + '/sensors/share', { method: 'POST', headers: H, body: JSON.stringify({ shared: ['sensor.a', 'light.x', 'sensor.a', 'zle id'] }) })).json();
        assert.deepStrictEqual(r.shared, ['sensor.a']);
        j = await (await fetch(base + '/sensors', { headers: H })).json();
        assert.deepStrictEqual(j.sensors.map(s => s.shared), [true, false]);
        assert.deepStrictEqual(new ha.Shared(dir).list(), ['sensor.a'], 'wybór przeżywa restart');
    } finally { server.close(); }
});

test('historia lokalna: dopisywanie, zapytanie po encji i godzinach, przycinanie po 7 dniach', () => {
    const { History } = require('../src/history');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    const h = new History(dir, { keepS: 7 * 86400, pruneEvery: 1000 });
    const now = 2_000_000_000;
    h.append([{ entity_id: 'pub.temp_in', value: 20, unit: '°C' }], now - 8 * 86400);
    h.append([{ entity_id: 'pub.temp_in', value: 21, unit: '°C' }, { entity_id: 'pub.door', value: 1 }], now - 3600);
    h.append([{ entity_id: 'pub.temp_in', value: 22, unit: '°C' }], now);
    assert.deepStrictEqual(h.query({ entity: 'pub.temp_in', hours: 24, now }).map(r => r.v), [21, 22]);
    assert.strictEqual(h.query({ hours: 24, now }).length, 3);
    assert.strictEqual(h.prune(now), 3, 'odczyt sprzed 8 dni wylatuje');
    assert.strictEqual(new History(dir).rows().length, 3, 'przeżywa restart');
});

test('LAN /data/status, /data/native, /data/history w formacie płytki, tylko z PIN-em', async () => {
    const { History } = require('../src/history');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    const history = new History(dir);
    history.append([{ entity_id: 'pub.temp_in', value: 21.4, unit: '°C' }]);
    const view = { status: { device_id: 'ab'.repeat(32), buffer_count: 1, uptime_s: 5, pub: [{ entity_id: 'pub.temp_in', value: '21.4', unit: '°C', age_s: 3 }], mon: [], own: [], pool: [] },
                   native: { count: 1, entities: [{ entity_id: 'temp_in', pub_id: 'pub.temp_in', value: '21.4', unit: '°C', age_s: 3 }] } };
    const server = lan.start({ port: 0, pin: '123456', identity: { id: 'ab'.repeat(32), pubHex: '04' }, pairing: new Pairing(dir), firmware: 'hub-test',
        data: () => view, history, log: () => {} });
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`, H = { Authorization: 'Bearer 123456' };
    try {
        assert.strictEqual((await fetch(base + '/data/status')).status, 403);
        const st = await (await fetch(base + '/data/status', { headers: H })).json();
        assert.deepStrictEqual(Object.keys(st), ['device_id', 'buffer_count', 'uptime_s', 'pub', 'mon', 'own', 'pool']);
        assert.strictEqual(st.pub[0].value, '21.4');
        const nat = await (await fetch(base + '/data/native', { headers: H })).json();
        assert.strictEqual(nat.entities[0].pub_id, 'pub.temp_in');
        const hist = await (await fetch(base + '/data/history?entity=pub.temp_in&hours=1', { headers: H })).json();
        assert.strictEqual(hist.count, 1);
        assert.strictEqual(hist.rows[0].v, 21.4);
    } finally { server.close(); }
});
