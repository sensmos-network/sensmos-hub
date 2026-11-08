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

module.exports = { config, toSensor, fetchSensors, HaSensors };
