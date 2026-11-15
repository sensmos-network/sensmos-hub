// Cudze czujniki LoRaWAN, wersja wąska (roadmapa q3-lorawan-czujniki): Hub jako brama „packet forwarder” (protokół
// Semtech UDP) do Twojego ChirpStacka albo The Things Stack. Nic nie dekodujemy sami: klucze czujnika (ABP) zostają
// w ChirpStacku, on sprawdza MIC i licznik, rozpakowuje dane gotowym kodekiem urządzenia i oddaje je do HA (MQTT albo
// integracja The Things Network). Sensmos tylko dowozi ramkę.
//
// Skąd ramki: nody Sensmos i tak przekazują do sieci obce ramki usłyszane w eterze (surowy hex, częstotliwość, SF,
// RSSI, SNR). Hub zgłasza siecią swoje DevAddr (`lorawan_claim`), a sieć przysyła mu tylko ramki z tymi adresami
// (`lorawan_frame`). Treść jest zaszyfrowana kluczem AppSKey czujnika: ani nody, ani serwer jej nie czytają.
// Wersja wąska: tylko uplink, bez downlinku, więc tylko ABP (OTAA potrzebuje odpowiedzi Join Accept), czujnik
// na stałym kanale słyszanym przez nody (najlepiej 868.1 MHz SF11 = DR1, kanał domowy Sensmos).
const dgram = require('dgram');
const crypto = require('crypto');

const MAX_ADDRS = 20;
const DEDUP_S = 120;
const PULL_S = 30;      // PULL_DATA: ChirpStack i TTN widzą bramę jako połączoną
const STAT_S = 60;

// "26 01 1A 2B", "26011a2b", "0x26011A2B" → "26011a2b" (kolejność jak w ChirpStacku i TTN: najstarszy bajt pierwszy).
function parseAddrs(s) {
    const out = [];
    for (const part of String(s || '').split(/[,;\n]+/)) {
        const a = part.replace(/^\s*0x/i, '').replace(/[\s:-]/g, '').toLowerCase();
        if (/^[0-9a-f]{8}$/.test(a) && !out.includes(a)) out.push(a);
    }
    return out.slice(0, MAX_ADDRS);
}

// Uplink LoRaWAN: MHDR 0x40 (unconfirmed) albo 0x80 (confirmed), wersja główna 0; DevAddr w ramce jest little-endian.
function devAddrOf(hex) {
    hex = String(hex || '').toLowerCase();
    if (hex.length < 24 || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) return null;   // MHDR+DevAddr+FCtrl+FCnt+MIC = 12 B
    const mhdr = parseInt(hex.slice(0, 2), 16);
    if (mhdr !== 0x40 && mhdr !== 0x80) return null;
    return hex.slice(8, 10) + hex.slice(6, 8) + hex.slice(4, 6) + hex.slice(2, 4);
}

// Gateway EUI Huba: stały, z id urządzenia, z bitem „lokalnie nadany” (0x02 w pierwszym bajcie), żeby nie udawać cudzego EUI.
function gatewayEui(deviceId) {
    const b = crypto.createHash('sha256').update('sensmos-hub-gw:' + deviceId).digest().subarray(0, 8);
    b[0] = (b[0] | 0x02) & 0xfe;
    return b;
}

// Semtech UDP v2: [wersja 2][token 2 B][typ][EUI 8 B][JSON]. PUSH_DATA = 0x00, PULL_DATA = 0x02.
function packet(type, eui, json) {
    const head = Buffer.alloc(12);
    head[0] = 2; crypto.randomFillSync(head, 1, 2); head[3] = type; eui.copy(head, 4);
    return json ? Buffer.concat([head, Buffer.from(JSON.stringify(json))]) : head;
}

function rxpk(f, now = Date.now()) {
    const data = Buffer.from(f.hex, 'hex');
    return {
        time: new Date((+f.ts || now / 1000) * 1000).toISOString(),
        tmst: Math.floor(now * 1000) >>> 0,
        chan: 0, rfch: 0, stat: 1, modu: 'LORA',
        freq: Math.round((+f.freq || 868.1) * 1e4) / 1e4,
        datr: `SF${+f.sf || 11}BW125`, codr: '4/5',
        rssi: Math.round(+f.rssi || 0), lsnr: Math.round((+f.snr || 0) * 10) / 10,
        size: data.length, data: data.toString('base64'),
    };
}

class LoRaWan {
    // forward = "host:port" ChirpStack Gateway Bridge albo The Things Stack (np. eu1.cloud.thethings.network:1700).
    constructor({ forward, devaddrs, deviceId, log = () => {}, send = () => {}, socket } = {}) {
        const m = /^\s*([^\s:]+|\[[^\]]+\]):?(\d+)?\s*$/.exec(String(forward || ''));
        this.host = m ? m[1].replace(/^\[|\]$/g, '') : null;
        this.port = m && m[2] ? parseInt(m[2]) : 1700;
        this.addrs = parseAddrs(devaddrs);
        this.eui = gatewayEui(deviceId || '');
        this.log = log; this.send = send;
        this.sock = socket || null;
        this.seen = new Map();
        this.stats = { rxnb: 0, rxfw: 0 };
    }

    enabled() { return !!(this.host && this.addrs.length); }
    euiHex() { return this.eui.toString('hex').toUpperCase(); }

    start() {
        if (!this.enabled()) return this;
        if (!this.sock) {
            this.sock = dgram.createSocket(this.host.includes(':') ? 'udp6' : 'udp4');
            this.sock.on('error', e => this.log('LoRaWAN: UDP', e.message));
            this.sock.on('message', () => {});   // PUSH_ACK / PULL_ACK / PULL_RESP: downlinku nie nadajemy (Hub nie ma radia)
        }
        this.out(packet(0x02, this.eui));
        this.pullT = setInterval(() => this.out(packet(0x02, this.eui)), PULL_S * 1000);
        this.statT = setInterval(() => this.out(packet(0x00, this.eui, { stat: {
            time: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' GMT'),
            rxnb: this.stats.rxnb, rxok: this.stats.rxnb, rxfw: this.stats.rxfw, ackr: 100, dwnb: 0, txnb: 0 } })), STAT_S * 1000);
        this.log(`LoRaWAN: gateway EUI ${this.euiHex()} → ${this.host}:${this.port}, ${this.addrs.length} DevAddr (uplink only, ABP)`);
        return this;
    }

    stop() { clearInterval(this.pullT); clearInterval(this.statT); try { this.sock?.close(); } catch {} this.sock = null; }

    out(buf) { try { this.sock?.send(buf, this.port, this.host); } catch (e) { this.log('LoRaWAN:', e.message); } }

    // Po każdym połączeniu z siecią: które adresy mają do nas trafiać.
    claim() { if (this.enabled()) this.send({ type: 'lorawan_claim', devaddrs: this.addrs }); }

    // `lorawan_frame` z sieci: { hex, freq, sf, rssi, snr, ts, rx }. Zwraca rxpk albo null.
    onWs(f, now = Date.now()) {
        if (!this.enabled() || !f) return null;
        const hex = String(f.hex || '').toLowerCase();
        const a = devAddrOf(hex);
        if (!a || !this.addrs.includes(a)) return null;
        this.stats.rxnb++;
        // Tę samą ramkę słyszy kilka nodów: dalej idzie raz (ChirpStack i tak odsiewa, ale bez szumu w logu i w statystykach).
        const prev = this.seen.get(hex);
        this.seen.set(hex, now);
        if (this.seen.size > 300) for (const [k, t] of this.seen) if (now - t > DEDUP_S * 1000) this.seen.delete(k);
        if (prev && now - prev < DEDUP_S * 1000) return null;
        const pk = rxpk({ ...f, hex }, now);
        this.out(packet(0x00, this.eui, { rxpk: [pk] }));
        this.stats.rxfw++;
        this.log(`LoRaWAN: uplink ${a}, ${pk.size} B, ${pk.datr} ${pk.freq} MHz, RSSI ${pk.rssi}${f.rx ? ', heard by ' + String(f.rx).slice(0, 8) : ''}`);
        return pk;
    }
}

module.exports = { LoRaWan, parseAddrs, devAddrOf, gatewayEui, packet, rxpk, MAX_ADDRS };
