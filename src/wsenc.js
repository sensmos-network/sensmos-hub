// Kanał szyfrowany WS (kontrakt/protokol/ws.md §1.2) — strona noda.
// Ramka: ver(1) ‖ seq(8 BE) ‖ tag(16) ‖ ciphertext; AES-128-GCM, IV = 0x00000000 ‖ seq, AAD = ver ‖ seq.
// VER_JSON: plaintext = JSON. VER_TUN: plaintext = tid(u16 BE) ‖ ramka tunelu v2.
const crypto = require('crypto');

const VER_JSON = 1;
const VER_TUN = 2;

class Channel {
    // shared = ECDH(hub_priv, be_pub).x; salt = enonce_hub ‖ enonce_be
    constructor(ecdh, bePub, hubNonce, beNonce) {
        const shared = ecdh.computeSecret(bePub);
        const okm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([hubNonce, beNonce]), Buffer.from('sensmos-ws-v1'), 32));
        this.tx = okm.subarray(0, 16);
        this.rx = okm.subarray(16, 32);
        this.seqTx = 0n;
        this.seqRx = -1n;
    }

    seal(ver, plaintext) {
        const seq = this.seqTx++;
        const hdr = Buffer.alloc(9);
        hdr[0] = ver;
        hdr.writeBigUInt64BE(seq, 1);
        const c = crypto.createCipheriv('aes-128-gcm', this.tx, Buffer.concat([Buffer.alloc(4), hdr.subarray(1)]));
        c.setAAD(hdr);
        const ct = Buffer.concat([c.update(plaintext), c.final()]);
        return Buffer.concat([hdr, c.getAuthTag(), ct]);
    }

    sealJson(obj) { return this.seal(VER_JSON, Buffer.from(JSON.stringify(obj))); }

    sealTun(tid, frame) {
        const t = Buffer.alloc(2);
        t.writeUInt16BE(tid);
        return this.seal(VER_TUN, Buffer.concat([t, frame]));
    }

    // → { ver, plaintext } albo null (zła ramka, zły tag, powtórka)
    open(frame) {
        if (frame.length < 25) return null;
        const ver = frame[0];
        if (ver !== VER_JSON && ver !== VER_TUN) return null;
        const seq = frame.readBigUInt64BE(1);
        if (seq <= this.seqRx) return null;
        try {
            const d = crypto.createDecipheriv('aes-128-gcm', this.rx, Buffer.concat([Buffer.alloc(4), frame.subarray(1, 9)]));
            d.setAAD(frame.subarray(0, 9));
            d.setAuthTag(frame.subarray(9, 25));
            const plaintext = Buffer.concat([d.update(frame.subarray(25)), d.final()]);
            this.seqRx = seq;
            return { ver, plaintext };
        } catch { return null; }
    }
}

module.exports = { Channel, VER_JSON, VER_TUN };
