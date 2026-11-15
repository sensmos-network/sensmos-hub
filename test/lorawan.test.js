// Cudze czujniki LoRaWAN (0.2.0-beta7): filtr DevAddr, pakiety Semtech UDP, odsiew powtórek.
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const { LoRaWan, parseAddrs, devAddrOf, gatewayEui, packet } = require('../src/lorawan');

// Uplink ABP: MHDR 0x40, DevAddr 26011A2B (w ramce little-endian 2B1A0126), FCtrl 0, FCnt 7, FPort 1, 3 B, MIC.
const UP = '402b1a012600070001a1b2c3d4e5f6a7';

test('parseAddrs: różne zapisy, bez powtórek, najwyżej 20', () => {
    assert.deepStrictEqual(parseAddrs('26 01 1A 2B, 0x26011a2b;260B-0001\nzle'), ['26011a2b', '260b0001']);
    assert.equal(parseAddrs(Array.from({ length: 30 }, (_, i) => (0x26000000 + i).toString(16)).join(',')).length, 20);
});

test('devAddrOf: tylko uplink 0x40/0x80, adres odwrócony jak w ChirpStacku', () => {
    assert.equal(devAddrOf(UP), '26011a2b');
    assert.equal(devAddrOf('80' + UP.slice(2)), '26011a2b');
    assert.equal(devAddrOf('00' + UP.slice(2)), null);            // Join Request
    assert.equal(devAddrOf('e002' + UP.slice(4)), null);          // ramka Sensmos
    assert.equal(devAddrOf('402b1a0126'), null);                  // za krótka
});

test('gateway EUI: stały dla id, lokalnie nadany, nie multicast', () => {
    const a = gatewayEui('ab'.repeat(32)), b = gatewayEui('ab'.repeat(32));
    assert.ok(a.equals(b));
    assert.equal(a.length, 8);
    assert.equal(a[0] & 0x03, 0x02);
    assert.notDeepStrictEqual(gatewayEui('cd'.repeat(32)), a);
});

test('packet: nagłówek Semtech v2', () => {
    const p = packet(0x00, Buffer.alloc(8, 0x11), { rxpk: [] });
    assert.equal(p[0], 2); assert.equal(p[3], 0x00);
    assert.ok(p.subarray(4, 12).equals(Buffer.alloc(8, 0x11)));
    assert.deepStrictEqual(JSON.parse(p.subarray(12)), { rxpk: [] });
});

test('bez adresu albo bez celu: wyłączone, nic nie zgłasza', () => {
    const sent = [];
    const w = new LoRaWan({ forward: '', devaddrs: '26011a2b', deviceId: 'x', send: o => sent.push(o) });
    assert.equal(w.enabled(), false);
    w.claim();
    assert.deepStrictEqual(sent, []);
    assert.equal(w.onWs({ hex: UP }), null);
});

test('zgłoszenie adresów i przekazanie ramki do ChirpStacka (UDP), powtórka raz', async () => {
    const srv = dgram.createSocket('udp4');
    await new Promise(r => srv.bind(0, '127.0.0.1', r));
    const got = [];
    srv.on('message', m => got.push(m));
    const sent = [];
    const w = new LoRaWan({ forward: `127.0.0.1:${srv.address().port}`, devaddrs: '26011A2B', deviceId: 'ab'.repeat(32), send: o => sent.push(o) });
    w.start();
    w.claim();
    assert.deepStrictEqual(sent, [{ type: 'lorawan_claim', devaddrs: ['26011a2b'] }]);
    const pk = w.onWs({ hex: UP.toUpperCase(), freq: 868.1, sf: 11, rssi: -112.4, snr: -7.25, ts: 1794800000, rx: 'a1b2c3d4' });
    assert.equal(pk.datr, 'SF11BW125');
    assert.equal(pk.size, 16);
    assert.equal(Buffer.from(pk.data, 'base64').toString('hex'), UP);
    assert.equal(w.onWs({ hex: UP, freq: 868.1, sf: 11 }), null);                  // drugi nod usłyszał to samo
    assert.equal(w.onWs({ hex: '40' + '01020304' + UP.slice(10) }), null);         // cudzy adres
    await new Promise(r => setTimeout(r, 200));
    w.stop(); srv.close();
    const push = got.filter(m => m[3] === 0x00).map(m => JSON.parse(m.subarray(12)));
    const pull = got.filter(m => m[3] === 0x02);
    assert.equal(pull.length, 1);
    assert.ok(pull[0].subarray(4, 12).equals(gatewayEui('ab'.repeat(32))));
    assert.equal(push.length, 1);
    assert.equal(push[0].rxpk[0].freq, 868.1);
    assert.equal(push[0].rxpk[0].rssi, -112);
    assert.equal(push[0].rxpk[0].time, new Date(1794800000 * 1000).toISOString());
});
