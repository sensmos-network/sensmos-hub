// Parowanie i tunel v2 (kontrakt/protokol/tunel.md) — strona noda, zgodna z FW tunnel.cpp / pairing.cpp.
// Klucz parowania przychodzi z telefonu wyłącznie po LAN (POST /node/pair). Dowód otwarcia:
// HMAC-SHA256(klucz, "sensmos-tun-open|device_id|ip|port|ts"). Klucz sesji: SHA256(klucz ‖ "sensmos-tun-v2").
// Ramka: seq(u64 BE) ‖ nonce(12) ‖ ciphertext ‖ tag(16); AES-256-GCM; AAD = "tun2" ‖ ts(u32 BE) ‖ dir ‖ seq.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_KEYS = 4;
const OPEN_WINDOW_S = 120;
const CHUNK = 1024;
const DIR_TO_APP = 0, DIR_TO_LAN = 1;

class Pairing {
    constructor(dir) {
        this.file = path.join(dir, 'pairing.json');
        this.keys = [];
        try { this.keys = JSON.parse(fs.readFileSync(this.file, 'utf8')).map(h => Buffer.from(h, 'hex')).filter(k => k.length === 32); }
        catch { this.keys = []; }
    }
    save() { fs.writeFileSync(this.file, JSON.stringify(this.keys.map(k => k.toString('hex'))) + '\n', { mode: 0o600 }); }
    count() { return this.keys.length; }
    has() { return this.keys.length > 0; }
    add(key) {
        if (key.length !== 32) return false;
        if (this.keys.some(k => k.equals(key))) return true;
        if (this.keys.length >= MAX_KEYS) this.keys.shift();
        this.keys.push(key);
        this.save();
        return true;
    }
    clear() { this.keys = []; this.save(); }
    // indeks klucza, którym policzono dowód, albo -1
    verifyIdx(msg, proofHex) {
        const proof = Buffer.from(proofHex, 'hex');
        if (proof.length !== 32) return -1;
        return this.keys.findIndex(k => crypto.timingSafeEqual(crypto.createHmac('sha256', k).update(msg).digest(), proof));
    }
}

class Session {
    constructor(pairKey, ts) {
        this.key = crypto.createHash('sha256').update(Buffer.concat([pairKey, Buffer.from('sensmos-tun-v2')])).digest();
        this.ts = ts >>> 0;
        this.seqTx = 0n;
        this.seqRx = -1n;
    }
    aad(dir, seq) {
        const b = Buffer.alloc(4 + 4 + 1 + 8);
        b.write('tun2', 0);
        b.writeUInt32BE(this.ts, 4);
        b[8] = dir;
        b.writeBigUInt64BE(seq, 9);
        return b;
    }
    seal(plain, nonce = crypto.randomBytes(12), dir = DIR_TO_APP) {   // nod → apka; nonce i dir tylko do testów
        const seq = this.seqTx++;
        const c = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
        c.setAAD(this.aad(dir, seq));
        const ct = Buffer.concat([c.update(plain), c.final()]);
        const s = Buffer.alloc(8); s.writeBigUInt64BE(seq);
        return Buffer.concat([s, nonce, ct, c.getAuthTag()]);
    }
    open(frame, dir = DIR_TO_LAN) {   // apka → nod; null = zerwać sesję (dir tylko do testów na wektorach)
        if (frame.length <= 36) return null;
        const seq = frame.readBigUInt64BE(0);
        if (seq <= this.seqRx) return null;
        try {
            const d = crypto.createDecipheriv('aes-256-gcm', this.key, frame.subarray(8, 20));
            d.setAAD(this.aad(dir, seq));
            d.setAuthTag(frame.subarray(frame.length - 16));
            const pt = Buffer.concat([d.update(frame.subarray(20, frame.length - 16)), d.final()]);
            this.seqRx = seq;
            return pt;
        } catch { return null; }
    }
}

function isPrivate(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
        || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

// send(obj) wysyła JSON do BE, sendTun(tid, frame) ramkę VER_TUN; deviceId do dowodu.
class Tunnels {
    constructor({ pairing, deviceId, send, sendTun, log }) {
        this.pairing = pairing; this.deviceId = deviceId; this.send = send; this.sendTun = sendTun; this.log = log;
        this.sessions = new Map();
        this.seen = new Map();   // proof → ts (anty-powtórka w oknie)
    }

    state(tid, st, msg) { this.send({ type: 'tun_state', tid, st, msg }); }

    onOpen(m) {
        const tid = m.tid | 0, ip = String(m.ip || ''), port = m.port | 0, ts = m.ts | 0;
        const deny = why => { this.state(tid, 'error', why); this.log(`tun_open odrzucony: ${why}`); };
        if (!this.pairing.has()) return deny('node not paired');
        if ((m.v | 0) !== 2) return deny('update the app');
        if (typeof m.proof !== 'string' || m.proof.length !== 64) return deny('missing proof');
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - ts) > OPEN_WINDOW_S) return deny('stale timestamp');
        if (net.isIPv4(ip) === false) return deny('target must be a literal IP');
        if (!isPrivate(ip)) return deny('only private LAN addresses allowed');
        if (this.sessions.has(tid)) return deny('busy');
        const idx = this.pairing.verifyIdx(`sensmos-tun-open|${this.deviceId}|${ip}|${port}|${ts}`, m.proof);
        if (idx < 0) return deny('bad proof');
        for (const [p, t] of this.seen) if (now - t > OPEN_WINDOW_S) this.seen.delete(p);
        if (this.seen.has(m.proof)) return deny('proof replayed');
        this.seen.set(m.proof, now);

        const sess = new Session(this.pairing.keys[idx], ts);
        const sock = net.connect({ host: ip, port, timeout: 8000 });
        const entry = { sock, sess, open: false };
        this.sessions.set(tid, entry);
        sock.once('connect', () => { entry.open = true; sock.setTimeout(0); this.state(tid, 'open', 'connected'); this.log(`tun open tid=${tid} → ${ip}:${port}`); });
        sock.on('data', buf => {
            for (let i = 0; i < buf.length; i += CHUNK) this.sendTun(tid, sess.seal(buf.subarray(i, i + CHUNK)));
        });
        sock.once('timeout', () => { if (!entry.open) { sock.destroy(); this.close(tid, 'error', 'connect failed'); } });
        sock.once('error', e => this.close(tid, entry.open ? 'closed' : 'error', entry.open ? 'lan closed' : 'connect failed'));
        sock.once('close', () => this.close(tid, 'closed', 'closed'));
    }

    onFrame(tid, frame) {
        const e = this.sessions.get(tid);
        if (!e) return;
        const pt = e.sess.open(frame);
        if (pt === null) { e.sock.destroy(); return this.close(tid, 'error', 'bad frame'); }
        e.sock.write(pt);
    }

    onClose(m) {
        const e = this.sessions.get(m.tid | 0);
        if (e) e.sock.destroy();
        this.close(m.tid | 0, 'closed', 'closed by app');
    }

    close(tid, st, msg) {
        const e = this.sessions.get(tid);
        if (!e) return;
        this.sessions.delete(tid);
        this.state(tid, st, msg);
        this.log(`tun ${st} tid=${tid} (${msg})`);
    }

    closeAll() { for (const [tid, e] of this.sessions) { e.sock.destroy(); this.sessions.delete(tid); } }
}

module.exports = { Pairing, Session, Tunnels, isPrivate, OPEN_WINDOW_S };
