// LoRa w Hubie bez radia: czujnik LoRa nadaje ramkę DATA (0xE0 0x02) do Hubu (dst = pierwsze 4 B device_id),
// słyszy ją dowolny nod Sensmos w zasięgu, a BE dowozi hex po WS (`lora_frame`) — na ślepo, bez klucza.
// Hub dekoduje jak płytka (FW lora_scan.cpp data_rx_process), trzyma ostatnie ramki i potwierdza odbiór kwitem
// (`lora_data_rcpt`, same metadane). Klucz = SHA256(frazy) jak w FW; fraza nie jest zapisywana, tylko skrót.
//   [E0][02][flagi][dst 4][sub] + (AES: [nonce 4]) + [payload][CRC32 LE]   flagi: bit0 AES, bit1 LAST
//   AES-256-CTR, licznik = nonce4 ‖ dst4 ‖ sub ‖ 0×7, szyfrowany payload+CRC; CRC32 z jawnego payloadu.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const F_AES = 0x01, HDR = 8, NONCE = 4, PAYLOAD_MAX = 128;
const RING = 6;          // FW: LORA_DATA_INBOX_SIZE
const DEDUP_S = 120;     // FW: ta sama suma w oknie 120 s = powtórka (ramkę zgłasza każdy, kto ją usłyszał)

const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = CRC_T[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

const keyFromPhrase = phrase => crypto.createHash('sha256').update(Buffer.from(String(phrase), 'utf8')).digest();

function ctr(key, nonce, dst, sub, data) {
    const iv = Buffer.alloc(16);
    nonce.copy(iv, 0); dst.copy(iv, 4); iv[8] = sub;
    const c = crypto.createDecipheriv('aes-256-ctr', key, iv);   // CTR: szyfrowanie == deszyfrowanie
    return Buffer.concat([c.update(data), c.final()]);
}

// FW data_is_text: drukowalne ASCII bez " i \ — bezpieczne 1:1 w JSON i w stanie HA.
const isText = p => p.length > 0 && [...p].every(b => b >= 0x20 && b <= 0x7E && b !== 0x22 && b !== 0x5C);

// Ramka do `dst8` → { sub, enc, payload, crc, fh } albo { err }. Te same reguły co FW i integracja HA (lora_frame.py).
function decode(hex, dst8, key, acceptOpen) {
    hex = String(hex || '').toLowerCase();
    if (hex.length % 2 || hex.length < 26 || hex.length > 408 || !/^[0-9a-f]+$/.test(hex)) return { err: 'format' };
    const d = Buffer.from(hex, 'hex');
    if (d[0] !== 0xE0 || d[1] !== 0x02) return { err: 'type' };
    if (d.subarray(3, 7).toString('hex') !== dst8) return { err: 'dst' };
    const sub = d[7], aes = !!(d[2] & F_AES);
    let buf;
    if (aes) {
        if (!key) return { err: 'no_key' };
        buf = d.subarray(HDR + NONCE);
        if (buf.length < 5 || buf.length > PAYLOAD_MAX + 4) return { err: 'len' };
        buf = ctr(key, d.subarray(HDR, HDR + NONCE), d.subarray(3, 7), sub, buf);
    } else {
        if (!acceptOpen) return { err: 'open_off' };
        buf = d.subarray(HDR);
        if (buf.length < 5 || buf.length > PAYLOAD_MAX + 4) return { err: 'len' };
    }
    const payload = buf.subarray(0, buf.length - 4), crc = buf.readUInt32LE(buf.length - 4);
    if (crc32(payload) !== crc) return { err: aes ? 'crc_key' : 'crc' };
    return { sub, enc: aes, payload: Buffer.from(payload), crc, fh: crc32(d) };
}

// Ramka DATA jak z /node/lorasend w FW (nonce losowy). Do testów i do nadania „przez sieć” (lora_send do BE).
function encode(dst8, sub, payload, key = null, nonce = crypto.randomBytes(NONCE)) {
    payload = Buffer.from(payload);
    const dst = Buffer.from(dst8, 'hex');
    const crc = Buffer.alloc(4); crc.writeUInt32LE(crc32(payload));
    const hdr = Buffer.concat([Buffer.from([0xE0, 0x02, key ? F_AES : 0]), dst, Buffer.from([sub & 0xFF])]);
    const body = Buffer.concat([payload, crc]);
    return (key ? Buffer.concat([hdr, nonce, ctr(key, nonce, dst, sub, body)]) : Buffer.concat([hdr, body])).toString('hex');
}

function item(fr, ts, via) {
    const it = { ts, sub: fr.sub, enc: fr.enc, via };
    if (isText(fr.payload)) it.text = fr.payload.toString('latin1'); else it.hex = fr.payload.toString('hex');
    return it;
}

// Stan LoRa Hubu w data/lora.json: skrót klucza (nie fraza), zgoda na jawne ramki, ostatnie ramki i ostatnia per sub
// (po restarcie HA i Hubu czujniki wracają od razu, a nie dopiero przy następnej ramce).
class Lora {
    constructor({ dir, deviceId, log = () => {}, send = () => false }) {
        this.file = path.join(dir, 'lora.json');
        this.deviceId = deviceId; this.id8 = deviceId.slice(0, 8).toLowerCase();
        this.log = log; this.send = send;
        this.key = null; this.open = false; this.frames = []; this.last = {};
        this.seen = new Map(); this.drops = {};
        this.listeners = [];
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (/^[0-9a-f]{64}$/.test(j.key || '')) this.key = Buffer.from(j.key, 'hex');
            this.open = j.open === true;
            if (Array.isArray(j.frames)) this.frames = j.frames.slice(-RING);
            if (j.last && typeof j.last === 'object') this.last = j.last;
        } catch {}
    }

    onFrame(fn) { this.listeners.push(fn); return this; }

    save() {
        const j = { key: this.key ? this.key.toString('hex') : null, open: this.open, frames: this.frames, last: this.last };
        try { fs.writeFileSync(this.file, JSON.stringify(j) + '\n', { mode: 0o600 }); }
        catch (e) { this.log('LoRa: nie zapisuję stanu:', e.message); }
    }

    // Jak POST /node/lora_rx w FW: key "" kasuje, pole pominięte = bez zmian.
    configure({ key, open } = {}) {
        if (typeof key === 'string') {
            this.key = key ? keyFromPhrase(key) : null;
            this.log(`LoRa: klucz odbioru ramek ${this.key ? 'ustawiony' : 'skasowany'}`);
        }
        if (typeof open === 'boolean' && open !== this.open) { this.open = open; this.log(`LoRa: odbiór jawnych ramek ${open ? 'włączony' : 'wyłączony'}`); }
        this.save();
        return this.state();
    }

    state() { return { key_set: !!this.key, open: this.open }; }

    // Pole `lora` w /info: apka pokazuje kafel LoRa, integracja HA czyta /lora/inbox. Rola 0 = bez beaconów.
    info() { return { board: 'hub', role: 0, rx_key: !!this.key, open: this.open, radio: false, id8: this.id8 }; }

    inbox() { return { cmds: { count: 0, items: [] }, frames: { count: this.frames.length, items: this.frames } }; }

    // `lora_frame` z BE. Zwraca wpis albo null (nie do nas, bez klucza, powtórka…).
    onWs(hex, now = Math.floor(Date.now() / 1000)) {
        const fr = decode(hex, this.id8, this.key, this.open);
        if (fr.err) {
            // Log raz na przyczynę: zły klucz u czujnika potrafi przysyłać ramki co minutę.
            if (fr.err !== 'dst' && !this.drops[fr.err]) {
                this.drops[fr.err] = 1;
                const why = { no_key: 'ramka szyfrowana, a Hub nie ma klucza (apka → LoRa → Odbiór ramek)', open_off: 'ramka jawna, a odbiór jawnych jest wyłączony',
                    crc_key: 'suma się nie zgadza — inny klucz w czujniku?', crc: 'suma się nie zgadza', len: 'zła długość', format: 'zły format', type: 'to nie ramka DATA' }[fr.err] || fr.err;
                this.log(`LoRa: ramka odrzucona: ${why}`);
            }
            return null;
        }
        const prev = this.seen.get(fr.crc);
        this.seen.set(fr.crc, now);
        if (this.seen.size > 200) for (const [k, t] of this.seen) if (now - t > DEDUP_S) this.seen.delete(k);
        if (prev !== undefined && now - prev < DEDUP_S) return null;
        delete this.drops.crc_key; delete this.drops.no_key;   // po poprawce klucza kolejny błąd znów trafi do logu
        const it = item(fr, now, 'ws');
        this.frames.push(it);
        if (this.frames.length > RING) this.frames.splice(0, this.frames.length - RING);
        this.last[String(fr.sub)] = it;
        this.save();
        // Kwit do BE (FW lora8): bez treści, BE wie tylko, że doszło (staty, podział ryczałtu RX).
        this.send({ type: 'lora_data_rcpt', sub: fr.sub, via: 'ws', len: fr.payload.length, enc: fr.enc, fh: fr.fh });
        // Bez treści w logu: log trafia do paczki diagnostycznej.
        this.log(`LoRa: ramka sub ${fr.sub}, ${fr.payload.length} B${fr.enc ? ', AES' : ''}`);
        for (const fn of this.listeners) { try { fn(it); } catch (e) { this.log('LoRa:', e.message); } }
        return it;
    }

    // POST /node/lorasend: Hub nie ma radia, więc ramkę nadaje „przez sieć” — BE dowozi ją do bazy adresata (FW: sent_ws).
    sendData({ dst, sub = 0, payload = '', aes = false }, connected) {
        dst = String(dst || '').toLowerCase();
        const p = Buffer.from(String(payload), 'utf8');
        if (!Number.isInteger(sub) || sub < 0 || sub > 255) return { error: 'sub 0-255' };
        if (!p.length || p.length > PAYLOAD_MAX) return { error: 'bad payload (1-128 B)' };
        if (!/^[0-9a-f]{8}$/.test(dst)) return { error: 'bad dst (8 hex)' };
        if (dst === this.id8) return { error: 'no radio' };     // nadanie do własnego czujnika wymaga radia
        if (aes && !this.key) return { error: 'aes without rx key' };
        if (!connected) return { error: 'no uplink (ws) for send' };
        const hex = encode(dst, sub, p, aes ? this.key : null);
        this.send({ type: 'lora_send', dst, sub, hex });
        this.log(`LoRa: ramka do ${dst} sub ${sub} wysłana przez sieć (${p.length} B${aes ? ', AES' : ''})`);
        return { status: 'sent_ws' };
    }
}

module.exports = { Lora, decode, encode, crc32, keyFromPhrase, isText, RING };
