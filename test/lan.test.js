const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const lan = require('../src/lan');
const measure = require('../src/measure');
const { Pairing } = require('../src/tunnel');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    const pairing = new Pairing(dir);
    const identity = { id: 'ab'.repeat(32), pubHex: '04' + '11'.repeat(64) };
    const server = lan.start({ port: 0, pin: '123456', identity, pairing, firmware: 'hub-test', log: () => {} });
    return new Promise(resolve => server.once('listening', () => resolve({ server, pairing, base: `http://127.0.0.1:${server.address().port}` })));
}

test('LAN API: info bez PIN-u, config i parowanie z PIN-em, blokada po 5 błędach', async () => {
    const { server, pairing, base } = await fixture();
    try {
        const info = await (await fetch(base + '/info')).json();
        assert.strictEqual(info.hub, true);
        assert.strictEqual(info.paired, false);
        assert.strictEqual((await fetch(base + '/config')).status, 403);
        assert.strictEqual((await fetch(base + '/config', { headers: { Authorization: 'Bearer 123456' } })).status, 200);
        const key = 'cd'.repeat(32);
        const r = await fetch(base + '/node/pair', { method: 'POST', headers: { Authorization: 'Bearer 123456', 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        assert.deepStrictEqual(await r.json(), { status: 'ok', keys: 1 });
        assert.strictEqual(pairing.count(), 1);
        const bad = await fetch(base + '/node/pair', { method: 'POST', headers: { Authorization: 'Bearer 123456', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'zz' }) });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual((await (await fetch(base + '/node/pair', { headers: { Authorization: 'Bearer 123456' } })).json()).keys, 1);
        assert.strictEqual((await fetch(base + '/node/pair', { method: 'DELETE', headers: { Authorization: 'Bearer 123456' } })).status, 200);
        assert.strictEqual(pairing.count(), 0);
        assert.strictEqual((await fetch(base + '/data')).status, 404);
        for (let i = 0; i < 5; i++) assert.strictEqual((await fetch(base + '/config', { headers: { Authorization: 'Bearer 000000' } })).status, 403);
        assert.strictEqual((await fetch(base + '/config', { headers: { Authorization: 'Bearer 123456' } })).status, 429, 'blokada 30 s także dla dobrego PIN-u');
    } finally { server.close(); }
});

test('measure: tcp do lokalnego serwera i do zamkniętego portu', async () => {
    const srv = net.createServer(s => s.end());
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
        const ok = await measure.tcp('127.0.0.1', srv.address().port, 2000);
        assert.strictEqual(ok.ok, true);
        assert.ok(ok.rtt >= 0 && ok.rtt < 2000);
        const recs = await measure.run([{ id: 0, kind: 'tcp', host: '127.0.0.1', port: srv.address().port, target_kind: 'target', to_region: 'EU' }]);
        assert.strictEqual(recs.length, 1);
        assert.strictEqual(recs[0].kind, 'net.tcp');
        assert.strictEqual(recs[0].tk, 'target');
        assert.deepStrictEqual(recs[0].x, { to_region: 'EU', to_lat: null, to_lon: null });
    } finally { srv.close(); }
    const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    assert.strictEqual((await measure.tcp('127.0.0.1', port, 1000)).ok, false);
    assert.deepStrictEqual(await measure.run([{ kind: 'trace', host: '1.1.1.1' }]), [], 'trace pomijany');
});
