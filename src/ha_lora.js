// Czujniki LoRa w Home Assistancie bez integracji z HACS: Hub sam zapisuje stany przez REST API HA
// (dodatek: API Supervisora, Docker: HUB_HA_URL + HUB_HA_TOKEN) i odpala zdarzenie `sensmos_lora_frame`.
//   sensor.sensmos_lora_<sub>         ostatnia treść ramki (liczba albo tekst/hex)
//   sensor.sensmos_lora_<sub>_<klucz> dla treści „klucz=wartość” rozdzielonych ; , albo spacją, np. „t=21.5;h=40;bat=87”
// Stany zapisane przez API znikają przy restarcie HA, więc Hub odnawia je co `everyS` z ostatnich ramek (data/lora.json).
const KEYS = {
    t: ['temperature', '°C'], temp: ['temperature', '°C'],
    h: ['humidity', '%'], hum: ['humidity', '%'], rh: ['humidity', '%'],
    p: ['pressure', 'hPa'], pres: ['pressure', 'hPa'],
    bat: ['battery', '%'], batt: ['battery', '%'],
    v: ['voltage', 'V'], vbat: ['voltage', 'V'], volt: ['voltage', 'V'],
    co2: ['carbon_dioxide', 'ppm'], lux: ['illuminance', 'lx'],
    pm25: ['pm25', 'µg/m³'], pm10: ['pm10', 'µg/m³'],
    rssi: ['signal_strength', 'dBm'],
};
const NUM = /^-?\d+(\.\d+)?$/;

// Treść ramki → { raw, values: { klucz: liczba|tekst } }. Pojedyncza liczba = stan liczbowy samego czujnika.
function parsePayload(it) {
    const raw = it.text != null ? it.text : it.hex || '';
    const values = {};
    if (it.text != null) {
        const parts = it.text.trim().split(/[;,\s]+/).filter(Boolean);
        const kv = parts.map(s => s.match(/^([A-Za-z][A-Za-z0-9_]{0,15})[=:](.{1,32})$/));
        if (parts.length && kv.every(Boolean))
            for (const [, k, v] of kv) values[k.toLowerCase()] = NUM.test(v) ? Number(v) : v;
    }
    return { raw, values, number: it.text != null && NUM.test(it.text.trim()) ? Number(it.text.trim()) : null };
}

// Stany do zapisania w HA dla jednej ramki: [{ entity_id, state, attributes }].
function toStates(it, { id8 } = {}) {
    const sub = Number(it.sub) || 0;
    const base = `sensor.sensmos_lora_${sub}`;
    const common = { sub, encrypted: !!it.enc, via: it.via || null, ts: it.ts || null, hub: id8 || null };
    const { raw, values, number } = parsePayload(it);
    const label = sub ? `Sensmos LoRa ${sub}` : 'Sensmos LoRa';
    const out = [{
        entity_id: base,
        state: number != null ? number : raw.length > 255 ? raw.slice(0, 254) + '…' : raw,
        attributes: { ...common, friendly_name: label, icon: 'mdi:radio-tower', ...(number != null ? { state_class: 'measurement' } : {}),
            ...(it.hex ? { hex: it.hex } : {}), ...(Object.keys(values).length ? { values } : {}) },
    }];
    for (const [k, v] of Object.entries(values)) {
        const [device_class, unit] = KEYS[k] || [];
        const num = typeof v === 'number';
        out.push({
            entity_id: `${base}_${k}`,
            state: v,
            attributes: { ...common, friendly_name: `${label} ${k}`,
                ...(num ? { state_class: 'measurement' } : {}),
                ...(num && device_class ? { device_class, unit_of_measurement: unit } : {}) },
        });
    }
    return out;
}

class HaLora {
    constructor({ cfg, lora, log, everyS = 300, timeoutMs = 8000 }) {
        this.cfg = cfg; this.lora = lora; this.log = log; this.everyS = everyS; this.timeoutMs = timeoutMs;
        this.error = null; this.written = new Set();
    }

    async post(p, body) {
        const r = await fetch(this.cfg.url + p, {
            method: 'POST', body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (r.status === 401 || r.status === 403) throw new Error(`HA odrzucił token (${r.status})`);
        if (!r.ok) throw new Error(`HA odpowiedział ${r.status}`);
    }

    async write(it) {
        try {
            for (const s of toStates(it, { id8: this.lora.id8 })) {
                await this.post('/api/states/' + s.entity_id, { state: s.state, attributes: s.attributes });
                if (!this.written.has(s.entity_id)) { this.written.add(s.entity_id); this.log(`HA: czujnik LoRa ${s.entity_id}`); }
            }
            if (this.error) this.log('HA: zapis czujników LoRa znów działa');
            this.error = null;
            return true;
        } catch (e) {
            if (this.error !== e.message) this.log(`HA: czujniki LoRa niezapisane: ${e.message}`);
            this.error = e.message;
            return false;
        }
    }

    // Nowa ramka: stany + zdarzenie dla automatyzacji (ta sama nazwa co w integracji Sensmos).
    async onFrame(it) {
        const ok = await this.write(it);
        if (!ok) return false;
        try {
            await this.post('/api/events/sensmos_lora_frame', { node_id: this.lora.deviceId, sub: it.sub, text: it.text ?? null, hex: it.hex ?? null, enc: !!it.enc, via: it.via, ts: it.ts });
        } catch (e) { this.log(`HA: zdarzenie LoRa niewysłane: ${e.message}`); }
        return true;
    }

    // Odnowienie po restarcie HA (stany z API nie przeżywają restartu). Czujnik milczący ponad 7 dni nie wraca.
    async refresh(now = Math.floor(Date.now() / 1000)) {
        for (const it of Object.values(this.lora.last)) {
            if (now - (it.ts || 0) > 7 * 86400) continue;
            if (!(await this.write(it))) return false;
        }
        return true;
    }

    start() {
        this.lora.onFrame(it => { this.onFrame(it); });
        this.refresh();
        this.t = setInterval(() => this.refresh(), this.everyS * 1000);
        return this;
    }
    stop() { clearInterval(this.t); }
}

module.exports = { HaLora, toStates, parsePayload };
