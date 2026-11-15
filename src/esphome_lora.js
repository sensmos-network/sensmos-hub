// Zwykłe ESPHome przez sieć Sensmos (roadmapa q3-esphome-zwykle): płytka z samym ESPHome, bez komponentu
// sensmos_lora, nadaje odczyty wbudowanym `packet_transport` przez radio `sx126x` na kanale domowym Sensmos.
// Nody i tak zgłaszają obce ramki z eteru. Hub zgłasza siecią nazwy swoich płytek (`esphome_claim`), BE dowozi mu
// tylko ramki z tymi nazwami (`esphome_frame`), a Hub odszyfrowuje je kluczem z YAML-a płytki i podaje dalej jak
// zwykły czujnik LoRa: sensor.sensmos_lora_<sub>_<id> w Home Assistant, cisza, zdarzenia, historia.
// Nazwa płytki idzie w eterze jawnie (tak działa packet_transport), treść jest zaszyfrowana; klucz zna tylko Hub.
//
// Format ramki (ESPHome packet_transport, wszystko little-endian):
//   [0x53 0x45 = MAGIC 0x4553][len][nazwa][zera do 4 B] + treść w słowach 32-bit (XXTEA, klucz SHA256(hasła), 8 słów)
//   treść: [1 DATA] albo [5 ROLLING_CODE][u32 lo][u32 hi], potem [4 PING][u32]…, [2 SENSOR][f32][len][id], [3 BINARY][u8][len][id]
const crypto = require('crypto');

const MAGIC = 0x4553, MAGIC_PING = 0x5048;
const K_ZERO = 0, K_DATA = 1, K_SENSOR = 2, K_BINARY = 3, K_PING = 4, K_ROLLING = 5;
const MAX_BOARDS = 20;
const DEDUP_S = 120;
const DELTA = 0x9e3779b9;

// XXTEA jak esphome/components/xxtea (klucz 256 bit: k[(p ^ e) & 7]).
function xxteaDecrypt(v, k) {
    const n = v.length;
    if (!n) return v;
    let q = 6 + Math.floor(52 / n), sum = (q * DELTA) >>> 0, y = v[0], z, e;
    const mx = p => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p ^ e) & 7] ^ z))) >>> 0;
    while (q-- > 0) {
        e = sum >>> 2;
        for (let p = n - 1; p > 0; p--) { z = v[p - 1]; y = v[p] = (v[p] - mx(p)) >>> 0; }
        z = v[n - 1];
        y = v[0] = (v[0] - mx(0)) >>> 0;
        sum = (sum - DELTA) >>> 0;
    }
    return v;
}

function xxteaEncrypt(v, k) {
    const n = v.length;
    if (!n) return v;
    let q = 6 + Math.floor(52 / n), sum = 0, z = v[n - 1], y, e;
    const mx = p => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p ^ e) & 7] ^ z))) >>> 0;
    while (q-- > 0) {
        sum = (sum + DELTA) >>> 0;
        e = sum >>> 2;
        let p;
        for (p = 0; p < n - 1; p++) { y = v[p + 1]; z = v[p] = (v[p] + mx(p)) >>> 0; }
        y = v[0];
        z = v[n - 1] = (v[n - 1] + mx(p)) >>> 0;
    }
    return v;
}

const keyWords = phrase => {
    const d = crypto.createHash('sha256').update(String(phrase), 'utf8').digest();
    return Array.from({ length: 8 }, (_, i) => d.readUInt32LE(4 * i));
};

// "dzialka-czujnik=20:haslo; garaz=21" → [{ name, sub, key }]. Nazwa jak `esphome: name:` płytki.
function parseBoards(s) {
    const out = [];
    for (const part of String(s || '').split(/[;\n]+/)) {
        const m = /^\s*([a-z0-9][a-z0-9_-]{0,30})\s*=\s*(\d{1,3})\s*(?::(.*))?$/i.exec(part);
        if (!m) continue;
        const name = m[1].toLowerCase(), sub = +m[2], pass = (m[3] || '').trim();
        if (sub < 1 || sub > 255 || out.some(b => b.name === name || b.sub === sub)) continue;
        out.push({ name, sub, key: pass ? keyWords(pass) : null });
    }
    return out.slice(0, MAX_BOARDS);
}

// Nazwa nadawcy z jawnego nagłówka albo null (to nie ramka danych packet_transport).
function nameOf(buf) {
    if (buf.length < 8 || buf.readUInt16LE(0) !== MAGIC) return null;
    const len = buf[2];
    if (!len || 3 + len > buf.length) return null;
    const name = buf.subarray(3, 3 + len).toString('latin1');
    return /^[a-z0-9][a-z0-9_-]*$/i.test(name) ? name.toLowerCase() : null;
}

const fmt = x => Number.isInteger(x) ? String(x) : String(+x.toFixed(4));

// Ramka → { name, values: { id: liczba }, code: [lo, hi] | null } albo { err }.
function decode(buf, key) {
    const name = nameOf(buf);
    if (!name) return { err: 'format' };
    let pos = (3 + buf[2] + 3) & ~3;
    const body = Buffer.from(buf.subarray(pos));
    if (!body.length || body.length % 4) return { err: 'len' };
    if (key) {
        const v = Array.from({ length: body.length / 4 }, (_, i) => body.readUInt32LE(4 * i));
        xxteaDecrypt(v, key).forEach((w, i) => body.writeUInt32LE(w, 4 * i));
    }
    let i = 0, code = null;
    const first = body[i++];
    if (first === K_ROLLING) {
        if (body.length < 9) return { err: 'len' };
        code = [body.readUInt32LE(1), body.readUInt32LE(5)]; i = 9;
    } else if (first !== K_DATA) return { err: key ? 'key' : 'format' };
    const values = {};
    while (i < body.length) {
        const k = body[i++];
        if (k === K_ZERO) continue;
        if (k === K_PING) { i += 4; continue; }
        if (k !== K_SENSOR && k !== K_BINARY) return { err: key ? 'key' : 'format' };
        const w = k === K_SENSOR ? 4 : 1;
        if (i + w + 1 > body.length) return { err: 'len' };
        const raw = k === K_SENSOR ? body.readFloatLE(i) : body[i];
        i += w;
        const n = body[i++];
        if (i + n > body.length) return { err: 'len' };
        const id = body.subarray(i, i + n).toString('latin1');
        i += n;
        if (!/^[A-Za-z0-9_]{1,64}$/.test(id)) return { err: key ? 'key' : 'format' };
        if (!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(id)) continue;   // HA dostaje klucze do 16 znaków (jak sensmos_lora)
        if (k === K_BINARY) values[id] = raw ? 1 : 0;
        else if (Number.isFinite(raw)) values[id] = +fmt(raw);
    }
    return { name, values, code };
}

class EspHomeLora {
    // boards = "nazwa=sub:hasło; …" (opcja dodatku esphome_lora / HUB_ESPHOME_LORA). lora = magazyn czujników Huba.
    constructor({ boards, lora, log = () => {}, send = () => {} } = {}) {
        this.boards = parseBoards(boards);
        this.lora = lora; this.log = log; this.send = send;
        this.seen = new Map(); this.codes = new Map(); this.drops = new Set();
    }

    enabled() { return this.boards.length > 0; }

    // Po każdym połączeniu z siecią: ramki z jakimi nazwami mają do nas trafiać.
    claim() { if (this.enabled()) this.send({ type: 'esphome_claim', names: this.boards.map(b => b.name) }); }

    // `esphome_frame` z sieci: { hex, rssi, snr, rx, near? }. Zwraca wpis czujnika albo null.
    onWs(m, now = Math.floor(Date.now() / 1000)) {
        if (!this.enabled() || !m) return null;
        const hex = String(m.hex || '').toLowerCase();
        if (hex.length < 16 || hex.length > 510 || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) return null;
        const buf = Buffer.from(hex, 'hex');
        const b = this.boards.find(x => x.name === nameOf(buf));
        if (!b) return null;
        // Tę samą ramkę słyszy kilka nodów.
        const prev = this.seen.get(hex);
        this.seen.set(hex, now);
        if (this.seen.size > 200) for (const [k, t] of this.seen) if (now - t > DEDUP_S) this.seen.delete(k);
        if (prev !== undefined && now - prev < DEDUP_S) return null;
        const fr = decode(buf, b.key);
        if (fr.err) {
            if (!this.drops.has(b.name + fr.err)) {
                this.drops.add(b.name + fr.err);
                this.log(`ESPHome LoRa: frame from ${b.name} refused: ${fr.err === 'key' ? 'cannot decrypt, is the encryption key the same as in the board YAML?' : fr.err}`);
            }
            return null;
        }
        // Rolling code (rolling_code_enable w płytce): starszy albo ten sam licznik = powtórka nagrana z eteru.
        if (fr.code) {
            const last = this.codes.get(b.name);
            if (last && (fr.code[1] < last[1] || (fr.code[1] === last[1] && fr.code[0] <= last[0]))) return null;
            this.codes.set(b.name, fr.code);
        }
        const text = Object.entries(fr.values).map(([k, v]) => `${k}=${v}`).join(';');
        if (!text) return null;
        this.drops.delete(b.name + 'key');
        return this.lora.accept({ sub: b.sub, enc: !!b.key, text }, now, m, 'esphome', `ESPHome LoRa: ${b.name} → sub ${b.sub}`);
    }
}

module.exports = { EspHomeLora, parseBoards, nameOf, decode, keyWords, xxteaEncrypt, xxteaDecrypt, MAGIC, MAGIC_PING };
