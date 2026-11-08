// Czujniki z Home Assistanta (plan „Hub jako brama czujników”, temat 1). Hub nie łączy się z czujnikami sam:
// czyta to, co HA już zna (ESPHome, Zigbee, MQTT…), przez REST API HA, tylko do odczytu.
//   add-on HA: wbudowane API Supervisora (SUPERVISOR_TOKEN, `homeassistant_api: true` w config.yaml)
//   Docker:    HUB_HA_URL (np. http://192.168.1.10:8123) + HUB_HA_TOKEN (long-lived token z profilu HA)
// Na tym etapie nic nie wychodzi do sieci Sensmos — wybór i wysyłka to kolejne tematy.
const DOMAINS = ['sensor', 'binary_sensor'];
const SKIP_STATES = new Set(['unknown', 'unavailable', '']);

function config(env = process.env) {
    if (env.HUB_HA_URL && env.HUB_HA_TOKEN) return { url: env.HUB_HA_URL.replace(/\/$/, ''), token: env.HUB_HA_TOKEN, via: 'token' };
    if (env.SUPERVISOR_TOKEN) return { url: 'http://supervisor/core', token: env.SUPERVISOR_TOKEN, via: 'add-on' };
    return null;
}

// Stan HA → czujnik: tylko sensor/binary_sensor z aktualną wartością. Liczba zostaje liczbą,
// binary_sensor = on/off, reszta (tekst) wypada — z tekstu nie zrobimy odczytu do sieci.
function toSensor(s) {
    const domain = String(s?.entity_id || '').split('.')[0];
    if (!DOMAINS.includes(domain)) return null;
    const raw = String(s.state ?? '');
    if (SKIP_STATES.has(raw)) return null;
    const a = s.attributes || {};
    let value;
    if (domain === 'binary_sensor') value = raw === 'on';
    else { value = Number(raw); if (!Number.isFinite(value)) return null; }
    return {
        entity_id: s.entity_id,
        name: String(a.friendly_name || s.entity_id).slice(0, 80),
        value,
        unit: a.unit_of_measurement ? String(a.unit_of_measurement).slice(0, 16) : null,
        device_class: a.device_class ? String(a.device_class).slice(0, 32) : null,
        updated: s.last_updated || null,
    };
}

async function fetchSensors(cfg, { timeoutMs = 8000 } = {}) {
    const r = await fetch(cfg.url + '/api/states', {
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 401 || r.status === 403) throw new Error(`HA odrzucił token (${r.status})`);
    if (!r.ok) throw new Error(`HA odpowiedział ${r.status}`);
    const states = await r.json();
    if (!Array.isArray(states)) throw new Error('HA: odpowiedź bez listy stanów');
    return states.map(toSensor).filter(Boolean).sort((x, y) => x.entity_id.localeCompare(y.entity_id));
}

// Odczyt co `everyS` sekund. Log tylko przy zmianie obrazu (pierwszy odczyt, inna liczba czujników, błąd/powrót),
// żeby nie zalać bufora zdarzeń tym samym co minutę.
class HaSensors {
    constructor({ cfg, log, everyS = 60 }) {
        this.cfg = cfg; this.log = log; this.everyS = everyS;
        this.sensors = []; this.at = null; this.error = null; this.lastSig = '';
    }

    async poll() {
        try {
            const list = await fetchSensors(this.cfg);
            this.sensors = list; this.at = new Date().toISOString();
            const sig = list.map(s => s.entity_id).join(',');
            if (this.error || sig !== this.lastSig) {
                // Bez wartości i nazw: log trafia do paczki diagnostycznej, a czujniki nieudostępnione nie wychodzą z domu.
                this.log(`HA (${this.cfg.via}): ${list.length} czujników`);
            }
            this.lastSig = sig; this.error = null;
        } catch (e) {
            if (this.error !== e.message) this.log(`HA: ${e.message} — czujniki niedostępne, ponawiam co ${this.everyS} s`);
            this.error = e.message;
        }
        return this.sensors;
    }

    start() { this.poll(); this.t = setInterval(() => this.poll(), this.everyS * 1000); return this; }
    stop() { clearInterval(this.t); }
    snapshot() { return { via: this.cfg.via, at: this.at, error: this.error, count: this.sensors.length, sensors: this.sensors }; }
}

// Wybór właściciela: które czujniki udostępnić sieci (temat 2). Domyślnie żaden. Plik data/shared.json,
// lista entity_id. Wysyłka do sieci to temat 3 — tu tylko zapamiętanie wyboru.
class Shared {
    constructor(dir) { this.file = require('path').join(dir, 'shared.json'); this.ids = new Set(this.read()); }
    read() { try { const j = JSON.parse(require('fs').readFileSync(this.file, 'utf8')); return Array.isArray(j.shared) ? j.shared.map(String) : []; } catch { return []; } }
    set(ids) {
        const clean = [...new Set((ids || []).map(String).filter(id => /^(sensor|binary_sensor)\.[a-z0-9_]{1,120}$/.test(id)))].slice(0, 200).sort();
        this.ids = new Set(clean);
        try { require('fs').writeFileSync(this.file, JSON.stringify({ shared: clean, at: new Date().toISOString() }, null, 1) + '\n'); }
        catch (e) { throw new Error('cannot save the choice: ' + e.message); }
        return clean;
    }
    has(id) { return this.ids.has(id); }
    list() { return [...this.ids]; }
}

// Udostępnione czujniki → encje batcha, tak jak wysyła je płytka ESP32 (pub.<natywna> do data_points, reszta own.*
// do danych właściciela). device_class HA → natywna encja Sensmos; pierwszy czujnik danej klasy wygrywa, kolejne
// tej samej klasy idą jako own.ha_<nazwa>, żeby nie nadpisywały się w jednym wierszu.
// Per domena: binary_sensor „battery” to niska bateria (0/1), nie poziom; „power” w binary_sensor to wł./wył.
const NATIVE_SENSOR = {
    temperature: 'temp_in', humidity: 'humidity_in', pressure: 'pressure', atmospheric_pressure: 'pressure',
    carbon_dioxide: 'co2', pm25: 'pm25', pm10: 'pm10', sound_pressure: 'noise_db',
    power: 'load_power', voltage: 'grid_v', battery: 'batt_soc',
};
const NATIVE_BINARY = { door: 'door', garage_door: 'door', window: 'window', motion: 'motion', occupancy: 'presence', presence: 'presence' };
const NATIVE = { ...NATIVE_SENSOR, ...NATIVE_BINARY };
// Jednostka natywnej encji w sieci; inne jednostki przeliczamy albo (gdy się nie da) wysyłamy jako own.*.
const UNIT = { temp_in: '°C', humidity_in: '%', pressure: 'hPa', co2: 'ppm', pm25: 'µg/m³', pm10: 'µg/m³', noise_db: 'dB', load_power: 'W', grid_v: 'V', batt_soc: '%' };
const CONVERT = {
    '°F>°C': v => (v - 32) * 5 / 9, 'K>°C': v => v - 273.15, 'kPa>hPa': v => v * 10, 'Pa>hPa': v => v / 100, 'mbar>hPa': v => v,
    'inHg>hPa': v => v * 33.8639, 'psi>hPa': v => v * 68.9476, 'kW>W': v => v * 1000, 'mV>V': v => v / 1000, 'dBA>dB': v => v,
    'μg/m³>µg/m³': v => v,
};
function nativeValue(nat, s, value) {
    if (typeof value !== 'number') return null;
    const want = UNIT[nat];
    if (!want) return { value, unit: s.unit || '' };   // binarne: 0/1 bez jednostki
    const have = s.unit || '';
    if (have === want) return { value, unit: want };
    const f = CONVERT[have + '>' + want];
    return f ? { value: Math.round(f(value) * 100) / 100, unit: want } : null;
}
function toEntities(sensors, isShared) {
    const used = new Set(), out = [];
    for (const s of sensors) {
        if (!isShared(s.entity_id)) continue;
        const value = typeof s.value === 'boolean' ? (s.value ? 1 : 0) : s.value;
        const ts = s.updated ? Math.floor(Date.parse(s.updated) / 1000) || 0 : 0;
        const [domain, obj] = s.entity_id.split('.');
        const nat = (domain === 'binary_sensor' ? NATIVE_BINARY : NATIVE_SENSOR)[s.device_class];
        const nv = nat && !used.has(nat) ? nativeValue(nat, s, value) : null;
        if (nv) { used.add(nat); out.push({ entity_id: 'pub.' + nat, value: nv.value, unit: nv.unit, last_updated: ts }); continue; }
        // own.ha_s_<obj> / own.ha_b_<obj>: 48 znaków jak w BE (soft_data), domena w nazwie = bez kolizji
        const own = 'own.ha_' + (domain === 'binary_sensor' ? 'b_' : 's_') + obj.slice(0, 39);
        out.push({ entity_id: own, value, unit: s.unit || '', last_updated: ts });
    }
    return out;
}

module.exports = { config, toSensor, fetchSensors, HaSensors, Shared, toEntities, NATIVE };
