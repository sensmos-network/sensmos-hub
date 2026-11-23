// Sensmos Pro dla informatyków (src/pro_net.js): strony i certyfikaty, internet, spis urządzeń z ARP.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net2 = require('../src/pro_net');
const { parseLan, runLan } = require('../src/pro');

test('lista kontroli: strony HTTP(S) obok adresów i portów', () => {
    assert.deepEqual(parseLan('nas=192.168.1.5:445, sklep=https://sklep.pl/koszyk, https://intranet.local/?a=1, drukarka=192.168.1.20'), [
        { name: 'nas', host: '192.168.1.5', port: 445 },
        { name: 'sklep', url: 'https://sklep.pl/koszyk' },
        { name: 'intranet.local', url: 'https://intranet.local/?a=1' },
        { name: 'drukarka', host: '192.168.1.20', port: null },
    ]);
});

test('HTTP: status, czas; 500 = awaria; certyfikat dla https', async () => {
    const srv = http.createServer((req, res) => { res.statusCode = req.url === '/bad' ? 500 : 200; res.end('ok'); });
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const ok = await net2.httpCheck(base + '/');
    assert.equal(ok.ok, true); assert.equal(ok.status, 200); assert.ok(ok.ms >= 0);
    const bad = await net2.httpCheck(base + '/bad');
    assert.equal(bad.ok, false); assert.equal(bad.status, 500);
    srv.close();
    const dead = await net2.httpCheck('http://127.0.0.1:1/');
    assert.equal(dead.ok, false); assert.equal(dead.status, null); assert.ok(dead.error);
    const tlsr = await net2.httpCheck('https://x.example/', { getFn: async () => ({ status: 200, cert: { days: 9, trusted: true } }) });
    assert.deepEqual([tlsr.ok, tlsr.cert_days, tlsr.cert_trusted], [true, 9, true]);
    const own = await net2.httpCheck('https://nas.local/', { getFn: async () => ({ status: 200, cert: { days: 300, trusted: false } }) });
    assert.deepEqual([own.ok, own.cert_trusted], [true, false], 'własny certyfikat (NAS, drukarka) to nie awaria');
    const lan = await runLan([{ name: 'www', url: 'https://x.example/' }], { gateway: null, http: async () => ({ ok: true, ms: 5, status: 200, cert_days: 30 }) });
    assert.deepEqual(lan, [{ name: 'www', url: 'https://x.example/', ok: true, ms: 5, status: 200, cert_days: 30 }]);
});

test('ping: utrata i opóźnienie z wyjścia ping', () => {
    assert.deepEqual(net2.parsePing('5 packets transmitted, 4 received, 20% packet loss, time 812ms\nrtt min/avg/max/mdev = 9.120/12.345/20.001/3.100 ms'), { loss: 20, ms: 12 });
    assert.deepEqual(net2.parsePing('5 packets transmitted, 0 received, 100% packet loss'), { loss: 100, ms: null });
    assert.deepEqual(net2.parsePing(''), { loss: 100, ms: null });
});

test('spis urządzeń: stan wyjściowy bez alarmu, nowe urządzenie przez 24 h', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pronet-'));
    const arp = path.join(dir, 'arp');
    const head = 'IP address       HW type     Flags       HW address            Mask     Device\n';
    fs.writeFileSync(arp, head + '192.168.1.1      0x1         0x2         aa:bb:cc:00:00:01     *        eth0\n192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0\n');
    let t = Date.parse('2026-11-23T10:00:00Z');
    const d = new net2.Devices(dir, { arpFile: arp, now: () => t });
    assert.deepEqual(d.scan(), { now: 1, known: 1, new: [] }, 'pierwszy odczyt = stan wyjściowy');
    fs.writeFileSync(arp, head + '192.168.1.1      0x1         0x2         aa:bb:cc:00:00:01     *        eth0\n192.168.1.50     0x1         0x2         DE:AD:BE:EF:00:02     *        wlan0\n');
    t += 60000;
    const d2 = new net2.Devices(dir, { arpFile: arp, now: () => t });   // po restarcie agenta plik zostaje
    const s = d2.scan();
    assert.deepEqual(s.new, [{ mac: 'de:ad:be:ef:00:02', ip: '192.168.1.50', first: '2026-11-23T10:01:00.000Z' }]);
    t += 25 * 3600000;
    assert.deepEqual(d2.scan().new, [], 'po 24 h już znane');
    const list = d2.list();
    assert.deepEqual(list.map(x => x.ip), ['192.168.1.1', '192.168.1.50']);
});

test('ping niedostępny: pomiar połączeniami TCP zamiast fałszywych 100% strat', async () => {
    let n = 0;
    const r = await net2.tcpMany('1.1.1.1', 4, async () => { n++; if (n === 2) throw new Error('x'); return 10 + n; });
    assert.deepEqual(r, { loss: 25, ms: 13, via: 'tcp' });
});

test('przekierowanie http: status końcowy', async () => {
    const srv = http.createServer((req, res) => { if (req.url === '/') { res.writeHead(301, { location: '/ok' }); return res.end(); } res.end('ok'); });
    await new Promise(r => srv.listen(0, r));
    const r = await net2.httpCheck(`http://127.0.0.1:${srv.address().port}/`);
    srv.close();
    assert.deepEqual([r.ok, r.status], [true, 200]);
});
