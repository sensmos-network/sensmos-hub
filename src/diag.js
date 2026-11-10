// Paczka diagnostyczna hubu (program testerów, koncepcja §1): jeden JSON, który BE i Claude czytają
// tak samo. Bez sekretów: klucz prywatny, PIN i klucze parowania nigdy tu nie trafiają (BE i tak filtruje).
//   node src/index.js diag [--upload] [--scenario <id>] [--result ok|fail] [--note "…"]
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS_FILE = 'events.json';
const STATE_FILE = 'state.json';
const MAX_EVENTS = 500;

// Bufor zdarzeń (ostatnie linie logu) zapisywany na dysk, żeby `diag` z osobnego procesu
// (np. `docker compose exec`) widział to, co działo się w działającym hubie.
class Events {
    constructor(dir) {
        this.file = path.join(dir, EVENTS_FILE);
        this.buf = [];
        this.dirty = false;
        try { this.buf = JSON.parse(fs.readFileSync(this.file, 'utf8')).slice(-MAX_EVENTS); } catch {}
        this.t = setInterval(() => this.flush(), 30_000);
        this.t.unref?.();
    }
    push(line) {
        this.buf.push({ t: new Date().toISOString(), m: String(line).slice(0, 500) });
        if (this.buf.length > MAX_EVENTS) this.buf.splice(0, this.buf.length - MAX_EVENTS);
        this.dirty = true;
    }
    flush() {
        if (!this.dirty) return;
        try { fs.writeFileSync(this.file, JSON.stringify(this.buf) + '\n'); this.dirty = false; } catch {}
    }
    stop() { clearInterval(this.t); this.flush(); }
}

function writeState(dir, extra) {
    try { fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), ...extra }) + '\n'); } catch {}
}

function build({ dir, identity, firmware, cfg, pairingCount, scenario = null, extra = {} }) {
    let events = [], state = {};
    try { events = JSON.parse(fs.readFileSync(path.join(dir, EVENTS_FILE), 'utf8')); } catch {}
    try { state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')); } catch {}
    let registered = null;
    try { registered = JSON.parse(fs.readFileSync(path.join(dir, 'registered.json'), 'utf8')); } catch {}
    const startedAt = state.started_at ? +new Date(state.started_at) : null;
    return {
        schema: 1,
        component: 'hub',
        version: firmware,
        build: `node${process.versions.node} ${os.platform()}-${os.arch()}`,
        node_id: identity.id,
        scenario_id: scenario,
        device: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, totalmem: os.totalmem(), hostname_hash: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16) },
        uptime: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
        process_alive: state.pid ? isAlive(state.pid) : null,
        config: { be: cfg.be, port: cfg.port, owner: cfg.owner, mdns: cfg.mdns !== false, paired_phones: pairingCount, registered_at: registered?.at || null },
        events,
        errors: events.filter(e => /błąd|error|odrzucony|nieudana|rozłączony|refused|rejected|failed|disconnected/i.test(e.m)).slice(-50),
        metrics: { freemem: os.freemem(), loadavg: os.loadavg(), ...extra },
        created_at: new Date().toISOString(),
    };
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function upload({ be, identity, pkg, result = null, note = null }) {
    const ts = Math.floor(Date.now() / 1000);
    const body = {
        device_id: identity.id, ts, device_sig: identity.sign(`sensmos:diag:${identity.id}:${ts}`),
        scenario_id: pkg.scenario_id || undefined, result: result || undefined, note: note || undefined, package: pkg,
    };
    const r = await fetch(`${be.replace(/\/$/, '')}/v1/diag`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`BE ${r.status}: ${j.error || ''}`);
    return j;
}

module.exports = { Events, writeState, build, upload, EVENTS_FILE, STATE_FILE };
