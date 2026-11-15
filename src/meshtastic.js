// Most Meshtastic → Home Assistant (roadmapa q3-tryb-dual, pomysły LoRa 15.11). Hub NIE ma radia i niczego nie
// nadaje: dostaje wiadomości Meshtastic w formacie JSON z MQTT (nod Meshtastic z Wi-Fi publikuje do brokera HA,
// automatyzacja HA przekazuje każdą wiadomość na POST /meshtastic huba) i zamienia je na encje HA:
//   sensor.meshtastic_<id>          ostatnia wiadomość tekstowa od noda (atrybuty: nazwa, kanał, rssi, snr)
//   sensor.meshtastic_<id>_<klucz>  telemetria: temperatura, wilgotność, ciśnienie, bateria, napięcie, światło
// oraz zdarzenie `sensmos_meshtastic_message` dla automatyzacji. Pozycji GPS celowo nie zapisujemy.
// Ostatnie stany leżą w data/meshtastic.json i są odnawiane po restarcie HA (stany z API go nie przeżywają).
const fs = require('fs');
const path = require('path');

const KEYS = {
    temperature: ['temperature', '°C', 't'], relative_humidity: ['humidity', '%', 'h'],
    barometric_pressure: ['pressure', 'hPa', 'p'], battery_level: ['battery', '%', 'bat'],
    voltage: ['voltage', 'V', 'v'], lux: ['illuminance', 'lx', 'lux'],
};
const MAX_NODES = 100, SEEN_MAX = 500, TEXT_MAX = 240;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Wiadomość JSON z MQTT Meshtastic → { id, type, text?, values, name?, channel, rssi, snr, ts, packet } albo null.
function parse(m) {
    if (!m || typeof m !== 'object') return null;
    const from = Number(m.from);
    if (!Number.isInteger(from) || from < 0 || from > 0xffffffff) return null;
    const id = from.toString(16).padStart(8, '0');
    const p = m.payload && typeof m.payload === 'object' ? m.payload : {};
    const out = {
        id, type: String(m.type || ''), values: {}, channel: Number.isInteger(m.channel) ? m.channel : null,
        rssi: num(m.rssi), snr: num(m.snr), ts: Number.isInteger(m.timestamp) && m.timestamp > 0 ? m.timestamp : Math.floor(Date.now() / 1000),
        packet: m.id != null ? `${id}:${m.id}` : null,
    };
    if (out.type === 'text') {
        if (typeof p.text !== 'string' || !p.text.trim()) return null;
        out.text = p.text.slice(0, TEXT_MAX);
    } else if (out.type === 'telemetry') {
        for (const k of Object.keys(KEYS)) if (num(p[k]) != null) out.values[KEYS[k][2]] = Math.round(p[k] * 100) / 100;
        if (!Object.keys(out.values).length) return null;
    } else if (out.type === 'nodeinfo') {
        const n = String(p.longname || p.shortname || '').trim().slice(0, 40);
        if (!n) return null;
        out.name = n;
    } else return null;
    return out;
}

// Stan jednego noda Meshtastic → stany HA.
function toStates(n) {
    const base = `sensor.meshtastic_${n.id}`;
    const label = n.name ? `Meshtastic ${n.name}` : `Meshtastic !${n.id}`;
    const common = { node: '!' + n.id, rssi: n.rssi ?? null, snr: n.snr ?? null, ts: n.ts || null, via: 'meshtastic' };
    const out = [];
    if (n.text != null) out.push({ entity_id: base, state: n.text.length > 255 ? n.text.slice(0, 254) + '…' : n.text,
        attributes: { ...common, friendly_name: label, icon: 'mdi:message-text', channel: n.channel ?? null, text_ts: n.text_ts || null } });
    for (const [k, v] of Object.entries(n.values || {})) {
        const [device_class, unit] = Object.values(KEYS).find(x => x[2] === k) || [];
        out.push({ entity_id: `${base}_${k}`, state: v,
            attributes: { ...common, friendly_name: `${label} ${k}`, state_class: 'measurement', ...(device_class ? { device_class, unit_of_measurement: unit } : {}) } });
    }
    return out;
}

class Meshtastic {
    constructor({ dir, cfg, log, timeoutMs = 8000 }) {
        this.file = path.join(dir, 'meshtastic.json'); this.cfg = cfg; this.log = log || (() => {}); this.timeoutMs = timeoutMs;
        this.nodes = {}; this.seen = []; this.error = null;
        try { this.nodes = JSON.parse(fs.readFileSync(this.file, 'utf8')).nodes || {}; } catch {}
    }

    save() {
        try { fs.writeFileSync(this.file, JSON.stringify({ nodes: this.nodes }) + '\n', { mode: 0o600 }); }
        catch (e) { this.log('Meshtastic: cannot save state:', e.message); }
    }

    async post(p, body) {
        const r = await fetch(this.cfg.url + p, {
            method: 'POST', body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!r.ok) throw new Error(`HA answered ${r.status}`);
    }

    async write(n) {
        try {
            for (const s of toStates(n)) await this.post('/api/states/' + s.entity_id, { state: s.state, attributes: s.attributes });
            if (this.error) this.log('Meshtastic: writing to HA works again');
            this.error = null;
            return true;
        } catch (e) {
            if (this.error !== e.message) this.log(`Meshtastic: not written to HA: ${e.message}`);
            this.error = e.message;
            return false;
        }
    }

    // Jedna wiadomość z MQTT. Ten sam pakiet usłyszany przez kilka bramek Meshtastic liczymy raz.
    async ingest(m) {
        const x = parse(m);
        if (!x) return { ok: false, ignored: true };
        if (x.packet) {
            if (this.seen.includes(x.packet)) return { ok: true, duplicate: true };
            this.seen.push(x.packet); if (this.seen.length > SEEN_MAX) this.seen.shift();
        }
        if (!this.nodes[x.id] && Object.keys(this.nodes).length >= MAX_NODES) {
            const oldest = Object.entries(this.nodes).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))[0][0];
            delete this.nodes[oldest];
        }
        const n = this.nodes[x.id] || (this.nodes[x.id] = { id: x.id, values: {} });
        n.ts = x.ts; n.rssi = x.rssi; n.snr = x.snr;
        if (x.name) n.name = x.name;
        if (x.text != null) { n.text = x.text; n.text_ts = x.ts; n.channel = x.channel; }
        Object.assign(n.values, x.values);
        this.save();
        const ok = await this.write(n);
        if (ok && x.text != null) {
            try {
                await this.post('/api/events/sensmos_meshtastic_message',
                    { node: '!' + x.id, name: n.name || null, text: x.text, channel: x.channel, rssi: x.rssi, snr: x.snr, ts: x.ts });
            } catch (e) { this.log(`Meshtastic: event not sent: ${e.message}`); }
        }
        if (!this.known) this.known = new Set();
        if (!this.known.has(x.id)) { this.known.add(x.id); this.log(`Meshtastic: node !${x.id}${n.name ? ' (' + n.name + ')' : ''} in HA`); }
        return { ok, node: '!' + x.id, type: x.type };
    }

    // Po restarcie HA: odnów stany nodów słyszanych w ostatnich 7 dniach.
    async refresh(now = Math.floor(Date.now() / 1000)) {
        for (const n of Object.values(this.nodes)) {
            if (now - (n.ts || 0) > 7 * 86400) continue;
            if (!(await this.write(n))) return false;
        }
        return true;
    }

    start(everyS = 300) {
        if (Object.keys(this.nodes).length) this.refresh();
        this.t = setInterval(() => this.refresh(), everyS * 1000);
        return this;
    }
    stop() { clearInterval(this.t); }
}

module.exports = { Meshtastic, parse, toStates };
