// Paczka diagnostyczna: bufor zdarzeń na dysku, build bez sekretów, upload podpisany kluczem noda.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const identity = require('../src/identity');
const { Events, writeState, build, upload } = require('../src/diag');

const SPKI = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');

test('bufor zdarzeń: limit 500, zapis i odczyt z dysku', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-diag-'));
    const ev = new Events(dir);
    for (let i = 0; i < 600; i++) ev.push('zdarzenie ' + i);
    ev.stop();
    const again = new Events(dir);
    assert.strictEqual(again.buf.length, 500);
    assert.strictEqual(again.buf[0].m, 'zdarzenie 100');
    again.stop();
});

test('build: wersja, node_id, zdarzenia, błędy, bez PIN-u i kluczy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-diag-'));
    const id = identity.load(dir);
    fs.writeFileSync(path.join(dir, 'pin.txt'), '246810\n');
    fs.writeFileSync(path.join(dir, 'pairing.json'), JSON.stringify(['ab'.repeat(32)]));
    const ev = new Events(dir);
    ev.push('połączony z BE'); ev.push('tun_open odrzucony: bad proof'); ev.stop();
    writeState(dir, { version: 'hub-0.1.1' });
    const pkg = build({ dir, identity: id, firmware: 'hub-0.1.1', cfg: { be: 'http://be', port: 80, owner: '0x' + '1'.repeat(40) }, pairingCount: 1, scenario: 'hub-install' });
    assert.strictEqual(pkg.component, 'hub');
    assert.strictEqual(pkg.node_id, id.id);
    assert.strictEqual(pkg.scenario_id, 'hub-install');
    assert.strictEqual(pkg.events.length, 2);
    assert.strictEqual(pkg.errors.length, 1);
    assert.strictEqual(pkg.config.paired_phones, 1);
    assert.strictEqual(pkg.process_alive, true);
    const text = JSON.stringify(pkg);
    assert.ok(!text.includes('246810') && !text.includes('ab'.repeat(32)) && !text.includes(JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'))).priv));
});

test('upload: POST /v1/diag z podpisem noda, który BE może sprawdzić kluczem publicznym', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-diag-'));
    const id = identity.load(dir);
    let got = null;
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
            got = JSON.parse(b);
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', id: 7 }));
        });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
        const pkg = build({ dir, identity: id, firmware: 'hub-0.1.1', cfg: { be: 'x', port: 80, owner: '0x' + '1'.repeat(40) }, pairingCount: 0 });
        const r = await upload({ be: `http://127.0.0.1:${srv.address().port}`, identity: id, pkg, result: 'ok', note: 'działa' });
        assert.strictEqual(r.id, 7);
        assert.strictEqual(got.device_id, id.id);
        assert.strictEqual(got.result, 'ok');
        assert.strictEqual(got.package.component, 'hub');
        const key = crypto.createPublicKey({ key: Buffer.concat([SPKI, id.pub]), format: 'der', type: 'spki' });
        assert.ok(crypto.createVerify('SHA256').update(`sensmos:diag:${id.id}:${got.ts}`).verify(key, Buffer.from(got.device_sig, 'hex')));
    } finally { srv.close(); }
});
