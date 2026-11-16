// 0.2.0-beta8: potwierdzenie Huba z sensmos.com/my (iPhone bez apki). BE przekazuje prośbę po WS (attest_req),
// Hub podpisuje ten sam atest co w LAN /attest tylko z poprawnym PIN-em; 5 złych PIN-ów blokuje na 15 min.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../src/hub');
const hubAttest = require('../src/attest');

const OWNER = '0x5Cb314D83f0b15ACa87cAeA920f242A4D19a3Dd0';
const SEED = 'ab'.repeat(32);

function mk(owner = OWNER) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-att-'));
    const hub = new Hub({ be: 'http://127.0.0.1:9', data: dir, port: 0, pin: '123456', owner, mdns: false, ha: null, loraHa: false, log: () => {} });
    const out = [];
    hub.send = o => out.push(o);
    return { hub, out };
}

test('attest_req z dobrym PIN-em: podpisany kanoniczny atest, weryfikowalny kluczem Huba', () => {
    const { hub, out } = mk();
    hub.handle({ type: 'attest_req', rid: 'a1'.repeat(8), seed: SEED, gps_lat: '52.23', gps_lon: '21.01', pin: '123456' });
    assert.strictEqual(out.length, 1);
    const r = out[0];
    assert.strictEqual(r.type, 'attest_res');
    assert.strictEqual(r.rid, 'a1'.repeat(8));
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.attest, hubAttest.build(hub.id.id, OWNER, SEED, '52.23', '21.01'));
    assert.match(r.attest, /"owner":"0x5cb314d83f0b15aca87caea920f242a4d19a3dd0"/);
    assert.match(r.attest, /^\{"v":1,"kind":"hub","device_id":"[0-9a-f]{64}",/);
    assert.ok(typeof r.sig === 'string' && r.sig.length > 0);
});

test('attest_req: zły PIN, blokada po 5 próbach, złe dane, zły rid', () => {
    const { hub, out } = mk();
    const req = (o = {}) => hub.handle({ type: 'attest_req', rid: 'b2'.repeat(8), seed: SEED, gps_lat: '52.23', gps_lon: '21.01', pin: '123456', ...o });
    req({ seed: 'xyz' });
    assert.strictEqual(out.pop().error, 'bad_seed');
    req({ gps_lat: '52,23' });
    assert.strictEqual(out.pop().error, 'bad_location');
    req({ rid: 'nie-hex' });
    assert.strictEqual(out.length, 0, 'zły rid: bez odpowiedzi');
    for (let i = 0; i < 5; i++) { req({ pin: '000000' }); assert.strictEqual(out.pop().error, 'bad_pin'); }
    req();
    assert.strictEqual(out.pop().error, 'too_many_attempts', 'po 5 złych PIN-ach nawet dobry jest odrzucany');
    hub.attLockUntil = Date.now() - 1;
    req();
    assert.ok(out.pop().attest, 'po blokadzie znów działa');
});

test('attest_req bez właściciela: no_owner', () => {
    const { hub, out } = mk('');
    hub.handle({ type: 'attest_req', rid: 'c3'.repeat(8), seed: SEED, gps_lat: '1', gps_lon: '2', pin: '123456' });
    assert.strictEqual(out.pop().error, 'no_owner');
});
