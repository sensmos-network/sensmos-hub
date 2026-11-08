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

test('measure: parsowanie ping z Linuksa i Windows', () => {
    const linux = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=9.84 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=10.2 ms

--- 1.1.1.1 ping statistics ---
4 packets transmitted, 3 received, 25% packet loss, time 601ms
rtt min/avg/max/mdev = 9.840/10.113/10.400/0.230 ms
`;
    assert.deepStrictEqual(measure.parsePing(linux, 4, false), { ok: true, loss: 25, n: 4, rtt: 10.113, jit: 0.23 });
    const linuxDead = `--- 10.0.0.9 ping statistics ---
4 packets transmitted, 0 received, 100% packet loss, time 3091ms
`;
    assert.deepStrictEqual(measure.parsePing(linuxDead, 4, false), { ok: false, loss: 100, n: 4 });
    const win = `Pinging 1.1.1.1 with 32 bytes of data:
Reply from 1.1.1.1: bytes=32 time=10ms TTL=57

Ping statistics for 1.1.1.1:
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 9ms, Maximum = 13ms, Average = 11ms
`;
    assert.deepStrictEqual(measure.parsePing(win, 4, true), { ok: true, loss: 0, n: 4, rtt: 11, jit: 2 });
    assert.strictEqual(measure.parsePing('ping: unknown host', 4, false), null);
});

test('LAN API: /attest podpisuje kanoniczny atest Huba (własne id i właściciel), tylko z PIN-em', async () => {
    const crypto = require('crypto');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const identity = { id: 'ab'.repeat(32), pubHex: '04', sign: s => crypto.createSign('SHA256').update(s).sign(privateKey).toString('hex') };
    const server = lan.start({ port: 0, pin: '123456', identity, pairing: new Pairing(dir), firmware: 'hub-test', owner: '0xABCDEF0123456789abcdef0123456789ABCDEF01', log: () => {} });
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, pin = '123456') => fetch(base + '/attest', { method: 'POST', headers: { Authorization: `Bearer ${pin}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        const seed = 'ef'.repeat(32);
        assert.strictEqual((await post({ seed, gps_lat: '52.25', gps_lon: '21.0' }, '000000')).status, 403);
        assert.strictEqual((await post({ seed: 'x', gps_lat: '52.25', gps_lon: '21.0' })).status, 400);
        assert.strictEqual((await post({ seed, gps_lat: '52.25; rm', gps_lon: '21.0' })).status, 400);
        const j = await (await post({ seed, gps_lat: '52.25', gps_lon: '21.0' })).json();
        assert.strictEqual(j.attest, `{"v":1,"kind":"hub","device_id":"${'ab'.repeat(32)}","owner":"0xabcdef0123456789abcdef0123456789abcdef01","seed":"${seed}","gps_lat":"52.25","gps_lon":"21.0"}`);
        assert.ok(crypto.createVerify('SHA256').update(j.attest).verify(publicKey, Buffer.from(j.sig, 'hex')), 'podpis kluczem Huba');
    } finally { server.close(); }
});
