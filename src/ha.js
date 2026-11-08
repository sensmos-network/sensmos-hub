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
                this.log(`HA (${this.cfg.via}): ${list.length} czujników` + (list.length ? ': ' +
                    list.slice(0, 12).map(s => `${s.entity_id}=${s.value}${s.unit ? ' ' + s.unit : ''}`).join(', ') +
                    (list.length > 12 ? ` … +${list.length - 12}` : '') : ''));
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
        require('fs').writeFileSync(this.file, JSON.stringify({ shared: clean, at: new Date().toISOString() }, null, 1) + '\n');
        return clean;
    }
    has(id) { return this.ids.has(id); }
    list() { return [...this.ids]; }
}

// Udostępnione czujniki → encje batcha, tak jak wysyła je płytka ESP32 (pub.<natywna> do data_points, reszta own.*
// do danych właściciela). device_class HA → natywna encja Sensmos; pierwszy czujnik danej klasy wygrywa, kolejne
// tej samej klasy idą jako own.ha_<nazwa>, żeby nie nadpisywały się w jednym wierszu.
const NATIVE = {
    temperature: 'temp_in', humidity: 'humidity_in', pressure: 'pressure', atmospheric_pressure: 'pressure',
    carbon_dioxide: 'co2', pm25: 'pm25', pm10: 'pm10', sound_pressure: 'noise_db',
    door: 'door', garage_door: 'door', window: 'window', motion: 'motion', occupancy: 'presence', presence: 'presence',
    power: 'load_power', voltage: 'grid_v', battery: 'batt_soc',
};
function toEntities(sensors, isShared) {
    const used = new Set(), out = [];
    for (const s of sensors) {
        if (!isShared(s.entity_id)) continue;
        const value = typeof s.value === 'boolean' ? (s.value ? 1 : 0) : s.value;
        const ts = s.updated ? Math.floor(Date.parse(s.updated) / 1000) || 0 : 0;
        const nat = NATIVE[s.device_class];
        if (nat && !used.has(nat)) { used.add(nat); out.push({ entity_id: 'pub.' + nat, value, unit: s.unit || '', last_updated: ts }); continue; }
        const own = 'own.ha_' + s.entity_id.split('.')[1].slice(0, 40);
        out.push({ entity_id: own, value, unit: s.unit || '', last_updated: ts });
    }
    return out;
}

module.exports = { config, toSensor, fetchSensors, HaSensors, Shared, toEntities, NATIVE };
