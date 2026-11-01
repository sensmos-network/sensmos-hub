// Wektory z kontrakt/protokol/wektory: kanał WS (ws-enc.json) i tunel v2 (tunel-v2.json).
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Channel, VER_JSON } = require('../src/wsenc');
const { Session, Pairing, isPrivate } = require('../src/tunnel');

const W = process.env.SENSMOS_WEKTORY || path.join(__dirname, '..', '..', 'kontrakt', 'protokol', 'wektory');
const load = n => JSON.parse(fs.readFileSync(path.join(W, n), 'utf8'));
const hex = h => Buffer.from(h, 'hex');

function channelFrom(v) {
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(hex(v.node_priv));
    assert.strictEqual(ecdh.getPublicKey().toString('hex'), v.node_pub);
    return new Channel(ecdh, hex(v.be_pub), hex(v.fw_nonce), hex(v.be_nonce));
}

test('ws-enc: klucze sesji i ramki w obu kierunkach', () => {
    const v = load('ws-enc.json');
    const ch = channelFrom(v);
    assert.strictEqual(ch.tx.toString('hex'), v.key_fw2be);
    assert.strictEqual(ch.rx.toString('hex'), v.key_be2fw);
    for (const f of v.frames) {
        if (f.dir === 'fw2be') {
            ch.seqTx = BigInt(f.seq);
            assert.strictEqual(ch.seal(f.ver, Buffer.from(f.pt)).toString('hex'), f.frame, `seal seq=${f.seq}`);
        } else {
            const r = ch.open(hex(f.frame));
            assert.ok(r, `open seq=${f.seq}`);
            assert.strictEqual(r.ver, f.ver);
            if (f.pt_hex != null) assert.strictEqual(r.plaintext.toString('hex'), f.pt_hex);
            else assert.strictEqual(r.plaintext.toString(), f.pt);
        }
    }
});

test('ws-enc: złe ramki odrzucone', () => {
    const v = load('ws-enc.json');
    for (const b of v.bad) {
        const ch = channelFrom(v);
        if (b.dir === 'fw2be') ch.rx = ch.tx;   // ramka od noda otwierana jego kluczem = test samej koperty
        assert.strictEqual(ch.open(hex(b.frame)), null, b.opis);
    }
});

test('ws-enc: powtórka seq odrzucona', () => {
    const v = load('ws-enc.json');
    const ch = channelFrom(v);
    const f = v.frames.find(x => x.dir === 'be2fw');
    assert.ok(ch.open(hex(f.frame)));
    assert.strictEqual(ch.open(hex(f.frame)), null);
});

test('tunel v2: klucz sesji i ramki', () => {
    const v = load('tunel-v2.json');
    const s = new Session(hex(v.pair_key), v.ts);
    assert.strictEqual(s.key.toString('hex'), v.session_key);
    for (const f of v.frames) {
        if (f.dir === 0) {
            s.seqTx = BigInt(f.seq);
            assert.strictEqual(s.seal(Buffer.from(f.pt, 'latin1'), hex(f.nonce)).toString('hex'), f.frame, f.opis);
        } else {
            const pt = s.open(hex(f.frame));
            assert.ok(pt, f.opis);
            assert.strictEqual(pt.toString('latin1'), f.pt);
        }
    }
});

test('tunel v2: złe ramki odrzucone', () => {
    const v = load('tunel-v2.json');
    for (const b of v.bad) {
        const s = new Session(hex(v.pair_key), v.ts);
        assert.strictEqual(s.open(hex(b.frame), b.open_as_dir ?? 1), null, b.opis);
    }
});

test('parowanie: dowód HMAC jak w apce, limit 4 kluczy', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hub-'));
    const p = new Pairing(dir);
    assert.strictEqual(p.has(), false);
    const keys = Array.from({ length: 5 }, (_, i) => Buffer.alloc(32, i + 1));
    keys.forEach(k => assert.ok(p.add(k)));
    assert.strictEqual(p.count(), 4);
    const msg = 'sensmos-tun-open|dev|192.168.1.10|8123|1761830000';
    const proof = crypto.createHmac('sha256', keys[4]).update(msg).digest('hex');
    assert.strictEqual(p.verifyIdx(msg, proof), 3);
    assert.strictEqual(p.verifyIdx(msg, crypto.createHmac('sha256', keys[0]).update(msg).digest('hex')), -1, 'najstarszy klucz wypadł');
    assert.strictEqual(new Pairing(dir).count(), 4, 'zapis na dysku');
});

test('tunel: tylko adresy prywatne', () => {
    for (const ip of ['10.0.0.1', '192.168.68.15', '172.16.0.1', '172.31.255.1', '100.64.0.1', '127.0.0.1']) assert.ok(isPrivate(ip), ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1', 'abc', '192.168.1']) assert.ok(!isPrivate(ip), ip);
});
