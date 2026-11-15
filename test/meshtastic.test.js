// Most Meshtastic → HA: parsowanie JSON z MQTT, encje, zdarzenie, duplikaty z kilku bramek, odnowienie stanów.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Meshtastic, parse, toStates } = require('../src/meshtastic');

const TEXT = { channel: 0, from: 2130636288, id: 11, payload: { text: 'Woda w potoku rośnie' }, rssi: -97, snr: 4.5, sender: '!aabbccdd', timestamp: 1763200000, to: 4294967295, type: 'text' };
const TELE = { channel: 0, from: 2130636288, id: 12, payload: { temperature: 3.25, relative_humidity: 91, battery_level: 87, voltage: 3.98, air_util_tx: 0.3 }, type: 'telemetry', timestamp: 1763200060 };
const INFO = { from: 2130636288, id: 13, payload: { id: '!7efeee00', longname: 'Potok Górny', shortname: 'PG' }, type: 'nodeinfo' };

test('parse: tekst, telemetria, nodeinfo; pozycja i śmieci odrzucone', () => {
    assert.deepStrictEqual([parse(TEXT).id, parse(TEXT).text, parse(TEXT).packet], ['7efeee00', 'Woda w potoku rośnie', '7efeee00:11']);
    assert.deepStrictEqual(parse(TELE).values, { t: 3.25, h: 91, bat: 87, v: 3.98 });
    assert.strictEqual(parse(INFO).name, 'Potok Górny');
    assert.strictEqual(parse({ from: 1, type: 'position', payload: { latitude_i: 1, longitude_i: 2 } }), null);
    assert.strictEqual(parse({ from: -1, type: 'text', payload: { text: 'x' } }), null);
    assert.strictEqual(parse({ from: 1, type: 'text', payload: { text: '  ' } }), null);
    assert.strictEqual(parse('x'), null);
});

test('toStates: ostatni tekst i telemetria z device_class', () => {
    const s = toStates({ id: '7efeee00', name: 'Potok Górny', text: 'hej', values: { t: 3.2, bat: 80 }, rssi: -90 });
    const by = Object.fromEntries(s.map(x => [x.entity_id, x]));
    assert.strictEqual(by['sensor.meshtastic_7efeee00'].state, 'hej');
    assert.strictEqual(by['sensor.meshtastic_7efeee00_t'].attributes.device_class, 'temperature');
    assert.strictEqual(by['sensor.meshtastic_7efeee00_bat'].attributes.unit_of_measurement, '%');
    assert.strictEqual(by['sensor.meshtastic_7efeee00'].attributes.friendly_name, 'Meshtastic Potok Górny');
});

test('ingest: zapis do HA, zdarzenie, duplikat liczony raz, stan po restarcie', async () => {
    const got = [];
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push([req.url, JSON.parse(b)]); res.end('{}'); });
    }).listen(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
    try {
        const cfg = { url: `http://127.0.0.1:${srv.address().port}`, token: 't' };
        const m = new Meshtastic({ dir, cfg });
        assert.strictEqual((await m.ingest(INFO)).ok, true);
        assert.strictEqual((await m.ingest(TEXT)).ok, true);
        assert.strictEqual((await m.ingest(TEXT)).duplicate, true);
        await m.ingest(TELE);
        assert.strictEqual((await m.ingest({ type: 'position', from: 5 })).ignored, true);
        const ev = got.filter(([u]) => u === '/api/events/sensmos_meshtastic_message');
        assert.strictEqual(ev.length, 1);
        assert.deepStrictEqual([ev[0][1].node, ev[0][1].name, ev[0][1].text], ['!7efeee00', 'Potok Górny', 'Woda w potoku rośnie']);
        assert.ok(got.some(([u, b]) => u === '/api/states/sensor.meshtastic_7efeee00_t' && b.state === 3.25));
        const m2 = new Meshtastic({ dir, cfg });
        got.length = 0;
        await m2.refresh(1763200100);
        assert.ok(got.some(([u, b]) => u === '/api/states/sensor.meshtastic_7efeee00' && b.state === 'Woda w potoku rośnie'), 'stan wraca z pliku');
        assert.ok(!JSON.stringify(got).includes('latitude'), 'bez pozycji');
    } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LAN: POST /meshtastic tylko z PIN-em huba', async () => {
    const lan = require('../src/lan');
    const seen = [];
    const srv = lan.start({ port: 0, pin: '123456', identity: {}, pairing: { count: () => 0 }, firmware: 'hub-test', owner: '',
        mesh: { ingest: async m => { seen.push(m); return { ok: true }; } }, log: () => {} });
    await new Promise(r => srv.once('listening', r));
    const u = `http://127.0.0.1:${srv.address().port}/meshtastic`;
    try {
        let r = await fetch(u, { method: 'POST', body: JSON.stringify(TEXT), headers: { 'Content-Type': 'application/json' } });
        assert.strictEqual(r.status, 403);
        r = await fetch(u, { method: 'POST', body: JSON.stringify(TEXT), headers: { Authorization: 'Bearer 123456', 'Content-Type': 'application/json' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(seen.length, 1);
    } finally { srv.close(); }
});

test('pozycja tylko dla nodów z listy track: _where z latitude/longitude dla mapy HA', () => {
    const POS = { from: 2130636288, id: 21, type: 'position', timestamp: 1763200100, payload: { latitude_i: 502612345, longitude_i: 199376543, altitude: 312, sats_in_view: 9 } };
    assert.strictEqual(parse(POS), null);
    assert.strictEqual(parse(POS, ['00000001']), null);
    const x = parse(POS, ['7efeee00']);
    assert.deepStrictEqual(x.pos, { lat: 50.26123, lon: 19.93765, alt: 312, sats: 9 });
    assert.strictEqual(parse({ ...POS, payload: { latitude_i: 0, longitude_i: 0 } }, ['7efeee00']), null);
    const w = toStates({ id: '7efeee00', values: {}, pos: x.pos, pos_ts: 1763200100 }).find(s => s.entity_id === 'sensor.meshtastic_7efeee00_where');
    assert.strictEqual(w.attributes.latitude, 50.26123);
    assert.strictEqual(w.attributes.longitude, 19.93765);
    const { parseTrack } = require('../src/meshtastic');
    assert.deepStrictEqual(parseTrack('!7EFEEE00, 7efeee01;zle !7efeee00'), ['7efeee00', '7efeee01']);
    assert.strictEqual(toStates({ id: 'a', values: { iaq: 40 } })[0].attributes.unit_of_measurement, undefined);
});
