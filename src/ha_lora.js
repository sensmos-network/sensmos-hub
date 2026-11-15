// Czujniki LoRa w Home Assistancie bez integracji z HACS: Hub sam zapisuje stany przez REST API HA
// (dodatek: API Supervisora, Docker: HUB_HA_URL + HUB_HA_TOKEN) i odpala zdarzenie `sensmos_lora_frame`.
//   sensor.sensmos_lora_<sub>         ostatnia treść ramki (liczba albo tekst/hex)
//   sensor.sensmos_lora_<sub>_<klucz> dla treści „klucz=wartość” rozdzielonych ; , albo spacją, np. „t=21.5;h=40;bat=87”
// Stany zapisane przez API znikają przy restarcie HA, więc Hub odnawia je co `everyS` z ostatnich ramek (data/lora.json).
// „Czujnik zamilkł” (strażnik działki/garażu): binary_sensor.sensmos_lora_<sub>_silent (device_class problem) = on,
// gdy od ostatniej ramki minęło więcej niż max(silentMinS, 3 × zwykły odstęp), najwyżej 2 doby. Przy przejściu
// Hub odpala zdarzenie `sensmos_lora_silent`, a po pierwszej ramce po ciszy `sensmos_lora_back` (raz, także po restarcie Huba).
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
const SILENT_MAX_S = 2 * 86400;

// Po ilu sekundach ciszy czujnik uznajemy za milczący: 3 zwykłe odstępy (zgubiona ramka to jeszcze nie alarm), co najmniej minS.
function silentAfter(it, minS = 3600) {
    return Math.min(SILENT_MAX_S, Math.max(minS, 3 * (Number(it.gap) || 0)));
}

function silentState(it, now, minS) {
    const sub = Number(it.sub) || 0;
    const after = silentAfter(it, minS);
    return {
        entity_id: `binary_sensor.sensmos_lora_${sub}_silent`,
        state: now - (it.ts || 0) > after ? 'on' : 'off',
        attributes: { sub, friendly_name: `Sensmos LoRa ${sub ? sub + ' ' : ''}silent`, device_class: 'problem', icon: 'mdi:radio-tower',
            last_frame: it.ts || null, silent_after_s: after },
    };
}

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
    constructor({ cfg, lora, log, everyS = 300, timeoutMs = 8000, silentMinS = 3600 }) {
        this.cfg = cfg; this.lora = lora; this.log = log; this.everyS = everyS; this.timeoutMs = timeoutMs;
        this.silentMinS = silentMinS;
        this.error = null; this.written = new Set();
        // Czujniki, o których ciszy HA już wie (zapisane w lora.json, żeby restart Huba nie dublował zdarzeń).
        this.silent = new Set(Object.entries(lora.last || {}).filter(([, it]) => it && it.silent_sent).map(([k]) => k));
    }

    async post(p, body) {
        const r = await fetch(this.cfg.url + p, {
            method: 'POST', body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (r.status === 401 || r.status === 403) throw new Error(`HA rejected the token (${r.status})`);
        if (!r.ok) throw new Error(`HA answered ${r.status}`);
    }

    async write(it, now = Math.floor(Date.now() / 1000)) {
        try {
            for (const s of [...toStates(it, { id8: this.lora.id8 }), silentState(it, now, this.silentMinS)]) {
                await this.post('/api/states/' + s.entity_id, { state: s.state, attributes: s.attributes });
                if (!this.written.has(s.entity_id)) { this.written.add(s.entity_id); this.log(`HA: LoRa sensor ${s.entity_id}`); }
            }
            if (this.error) this.log('HA: writing LoRa sensors works again');
            this.error = null;
            return true;
        } catch (e) {
            if (this.error !== e.message) this.log(`HA: LoRa sensors not written: ${e.message}`);
            this.error = e.message;
            return false;
        }
    }

    // Nowa ramka: stany + zdarzenie dla automatyzacji (ta sama nazwa co w integracji Sensmos).
    async onFrame(it) {
        const ok = await this.write(it, it.ts || undefined);
        if (!ok) return false;
        try {
            await this.post('/api/events/sensmos_lora_frame', { node_id: this.lora.deviceId, sub: it.sub, text: it.text ?? null, hex: it.hex ?? null, enc: !!it.enc, via: it.via, ts: it.ts });
            const k = String(it.sub);
            if (this.silent.has(k)) {
                await this.post('/api/events/sensmos_lora_back', { node_id: this.lora.deviceId, sub: it.sub, ts: it.ts, silent_s: it.gap || null });
                this.silent.delete(k);
                this.log(`HA: LoRa sensor ${it.sub} is back`);
            }
        } catch (e) { this.log(`HA: LoRa event not sent: ${e.message}`); }
        return true;
    }

    // Przejście w ciszę: jedno zdarzenie na ciszę, znacznik w lora.json (nowa ramka go nadpisuje).
    async checkSilent(it, now) {
        const k = String(it.sub);
        if (this.silent.has(k) || silentState(it, now, this.silentMinS).state !== 'on') return;
        await this.post('/api/events/sensmos_lora_silent', { node_id: this.lora.deviceId, sub: it.sub, last_frame: it.ts, silent_s: now - it.ts });
        this.silent.add(k);
        it.silent_sent = now;
        this.lora.save();
        this.log(`HA: LoRa sensor ${it.sub} went silent`);
    }

    // Odnowienie po restarcie HA (stany z API nie przeżywają restartu). Czujnik milczący ponad 7 dni nie wraca.
    async refresh(now = Math.floor(Date.now() / 1000)) {
        for (const it of Object.values(this.lora.last)) {
            if (now - (it.ts || 0) > 7 * 86400) continue;
            if (!(await this.write(it, now))) return false;
            try { await this.checkSilent(it, now); } catch (e) { this.log(`HA: LoRa event not sent: ${e.message}`); }
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

module.exports = { HaLora, toStates, parsePayload, silentAfter };
