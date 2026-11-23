// Sensmos Pro — agent nadzoru dla instalatorów Home Assistanta i informatyków (osobny dodatek „Sensmos Pro”).
// Bez portfela, bez GALU, bez nagród i mapy: agent nie jest nodem sieci. Co `everyS` sekund zbiera stan
// instalacji klienta i wysyła podpisany raport HTTPS do BE (POST /v1/pro/report). Konto instalatora wskazuje
// kod instalatora (HUB_PRO_CODE). Sterowanie (restart, przeładowanie integracji, kopia, aktualizacja, usługa,
// automatyzacja z szablonu, logi, pełny podgląd encji) tylko poleceniami PODPISANYMI kluczem konta instalatora
// (ECDSA P-256 z przeglądarki, przypięty przy pierwszym połączeniu). BE nie może sam wydać polecenia.
// Klient wyłącza sterowanie opcją allow_control=false (wtedy agent tylko czyta).
//
// Co idzie w raporcie (i nic więcej):
//   ha:      czy Core odpowiada, wersja, stan, liczba encji, encje niedostępne (id + nazwa, max 100),
//            integracje z błędem konfiguracji, oczekujące aktualizacje (encje update.*), encje obserwowane
//            (tylko te wybrane przez instalatora w panelu — lista przychodzi w odpowiedzi BE)
//   host:    dysk, wersje OS/Supervisora, najnowsza kopia zapasowa (tylko dodatek HA, API Supervisora)
//   lan:     testy urządzeń w sieci klienta (HUB_PRO_LAN: „nazwa=host[:port]”, po przecinku) i bramy domyślnej
//   agent:   wersja, czas pracy, od kiedy nie było internetu (gdy raporty nie wychodziły)
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { UiTunnel, uiTarget } = require('./pro_ui');
const net2 = require('./pro_net');

const CODE_RE = /^SP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const MAX_UNAVAILABLE = 100, MAX_WATCH = 30, MAX_LAN = 20, CMD_MAX_AGE_S = 600, MAX_SNAPSHOT = 3000;
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]{1,120}$/;

function normCode(c) { return String(c || '').trim().toUpperCase().replace(/\s+/g, ''); }

// „nas=192.168.1.5:445, drukarka=192.168.1.20:9100, router=192.168.1.1, sklep=https://sklep.pl” →
// [{name, host, port|null}] albo {name, url} dla stron i usług HTTP(S) (status, czas, certyfikat)
function parseLan(spec) {
    const out = [];
    for (const raw of String(spec || '').split(/[,;\n]/)) {
        const s = raw.trim();
        if (!s) continue;
        let name, target;
        const eq = s.indexOf('=');
        if (eq > 0 && !/^https?:\/\//i.test(s)) { name = s.slice(0, eq).trim(); target = s.slice(eq + 1).trim(); } else { target = s; name = s; }
        if (/^https?:\/\/[^\s]+$/i.test(target)) {
            try { const u = new URL(target); out.push({ name: (name === s ? u.hostname : name).slice(0, 40), url: u.href.slice(0, 300) }); } catch { continue; }
            if (out.length >= MAX_LAN) break;
            continue;
        }
        const m = target.match(/^\[?([A-Za-z0-9.\-:]+?)\]?(?::(\d{1,5}))?$/);
        if (!m) continue;
        const port = m[2] ? Number(m[2]) : null;
        if (port !== null && (port < 1 || port > 65535)) continue;
        out.push({ name: name.slice(0, 40), host: m[1], port });
        if (out.length >= MAX_LAN) break;
    }
    return out;
}

function tcpCheck(host, port, timeoutMs = 3000) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const s = net.connect({ host, port });
        const done = ok => { s.destroy(); resolve({ ok, ms: ok ? Date.now() - t0 : null }); };
        s.setTimeout(timeoutMs, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

function pingCheck(host, timeoutS = 2) {
    return new Promise(resolve => {
        execFile('ping', ['-c', '1', '-W', String(timeoutS), host], { timeout: (timeoutS + 2) * 1000 }, (err, stdout) => {
            if (err) return resolve({ ok: false, ms: null });
            const m = String(stdout).match(/time[=<]([\d.]+)\s*ms/);
            resolve({ ok: true, ms: m ? Math.round(Number(m[1])) : null });
        });
    });
}

// Brama domyślna z /proc/net/route (Linux); null gdy brak.
function defaultGateway(file = '/proc/net/route') {
    try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length > 2 && f[1] === '00000000' && f[2] !== '00000000') {
                const h = f[2];
                return [6, 4, 2, 0].map(i => parseInt(h.slice(i, i + 2), 16)).join('.');
            }
        }
    } catch {}
    return null;
}

async function runLan(checks, { tcp = tcpCheck, ping = pingCheck, http = net2.httpCheck, gateway = defaultGateway() } = {}) {
    const list = gateway && !checks.some(c => c.host === gateway) ? [{ name: 'gateway', host: gateway, port: null }, ...checks] : checks;
    return Promise.all(list.map(async c => c.url ? { name: c.name, url: c.url, ...(await http(c.url)) }
        : ({ name: c.name, host: c.host, port: c.port, ...(c.port ? await tcp(c.host, c.port) : await ping(c.host)) })));
}

async function getJson(url, token, timeoutMs = 8000) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { const e = new Error(`${r.status}`); e.status = r.status; throw e; }
    return r.json();
}

// Stany HA → podsumowanie raportu. Funkcja czysta (testy).
function summarizeStates(states, watch = []) {
    const watchSet = new Set(watch);
    const unavailable = [], updates = [], watched = [];
    let total = 0, backupLast = null;
    for (const s of Array.isArray(states) ? states : []) {
        const id = String(s?.entity_id || '');
        if (!ENTITY_RE.test(id)) continue;
        total++;
        const a = s.attributes || {};
        const name = String(a.friendly_name || id).slice(0, 80);
        const domain = id.split('.')[0];
        if (s.state === 'unavailable' && unavailable.length < MAX_UNAVAILABLE) unavailable.push({ entity_id: id, name, since: s.last_changed || null });
        if (domain === 'update' && s.state === 'on') updates.push({ entity_id: id, title: String(a.title || name).slice(0, 80), installed: a.installed_version ? String(a.installed_version).slice(0, 32) : null, latest: a.latest_version ? String(a.latest_version).slice(0, 32) : null });
        if (id === 'sensor.backup_last_successful_automatic_backup' && !isNaN(Date.parse(s.state))) backupLast = new Date(s.state).toISOString();
        if (watchSet.has(id)) watched.push({ entity_id: id, name, state: String(s.state ?? '').slice(0, 64), unit: a.unit_of_measurement ? String(a.unit_of_measurement).slice(0, 16) : null, changed: s.last_changed || null });
    }
    for (const id of watchSet) if (!watched.some(w => w.entity_id === id)) watched.push({ entity_id: id, name: id, state: 'missing', unit: null, changed: null });
    return { entities: total, unavailable_count: (Array.isArray(states) ? states : []).filter(s => s?.state === 'unavailable').length, unavailable, updates, watched, ...(backupLast ? { backup_last: backupLast } : {}) };
}

async function collectHa(cfg, watch) {
    if (!cfg) return null;
    const out = { reachable: false };
    try {
        const conf = await getJson(cfg.url + '/api/config', cfg.token);
        out.reachable = true;
        out.version = conf.version || null;
        out.state = conf.state || null;               // RUNNING / NOT_RUNNING / STARTING …
        out.safe_mode = !!conf.safe_mode;
        out.recovery_mode = !!conf.recovery_mode;
        out.location = conf.location_name ? String(conf.location_name).slice(0, 64) : null;
    } catch (e) { out.error = e.status ? `HA answered ${e.status}` : 'HA does not respond'; return out; }
    try { Object.assign(out, summarizeStates(await getJson(cfg.url + '/api/states', cfg.token, 15000), watch)); }
    catch (e) { out.states_error = String(e.status || e.message).slice(0, 80); }
    // Integracje z błędem (Modbus, Solarman, Huawei…): endpoint frontendu, wymaga konta administratora.
    try {
        const entries = await getJson(cfg.url + '/api/config/config_entries/entry', cfg.token);
        out.integrations_failed = (Array.isArray(entries) ? entries : [])
            .filter(e => ['setup_error', 'setup_retry', 'migration_error', 'failed_unload'].includes(e.state))
            .slice(0, 50).map(e => ({ domain: String(e.domain).slice(0, 40), title: String(e.title || e.domain).slice(0, 80), state: e.state, reason: e.reason ? String(e.reason).slice(0, 120) : null }));
    } catch { out.integrations_failed = null; }
    return out;
}

// API Supervisora (tylko w dodatku: SUPERVISOR_TOKEN, hassio_api). Błąd = pole null, raport idzie dalej.
async function collectHost(env = process.env) {
    const token = env.SUPERVISOR_TOKEN;
    if (!token) return null;
    const base = env.HUB_SUPERVISOR_URL || 'http://supervisor';
    const data = async p => { try { return (await getJson(base + p, token)).data || null; } catch { return null; } };
    const [host, core, os, sup, backups] = await Promise.all([data('/host/info'), data('/core/info'), data('/os/info'), data('/supervisor/info'), data('/backups')]);
    const newest = (backups?.backups || []).map(b => b.date).filter(Boolean).sort().pop() || null;
    return {
        disk_total_gb: host?.disk_total ?? null, disk_used_gb: host?.disk_used ?? null, disk_free_gb: host?.disk_free ?? null,
        hostname: host?.hostname ? String(host.hostname).slice(0, 64) : null,
        core: core ? { version: core.version, latest: core.version_latest, update: !!core.update_available } : null,
        os: os ? { version: os.version, latest: os.version_latest, update: !!os.update_available } : null,
        supervisor: sup ? { version: sup.version, latest: sup.version_latest, update: !!sup.update_available, healthy: sup.healthy !== false, supported: sup.supported !== false } : null,
        backup_newest: newest, backups: backups?.backups ? backups.backups.length : null,
    };
}

class ProAgent {
    constructor({ code, be = 'https://sensmos.com', dir, identity, version, ha = null, lan = '', name = '', everyS = 60, log = console.log, env = process.env, lanOpts, control = true, ui = true, netWatch = true, devices = null }) {
        this.code = normCode(code);
        if (!CODE_RE.test(this.code)) throw new Error('Sensmos Pro: installer code like SP-ABCD-2345 required (panel sensmos.com/pro → Add client)');
        this.be = String(be).replace(/\/$/, ''); this.dir = dir; this.id = identity; this.version = version;
        this.ha = ha; this.lan = parseLan(lan); this.name = String(name || '').slice(0, 64); this.everyS = everyS;
        this.log = log; this.env = env; this.lanOpts = lanOpts;
        this.control = control; this.accountFile = path.join(dir, 'pro_account.json'); this.account = this.loadAccount(); this.done = [];
        this.watch = this.loadWatch(); this.started = Date.now(); this.offlineSince = null; this.lastErr = null;
        this.netWatch = netWatch; this.netAt = 0; this.netLast = null;
        // spis urządzeń: domyślnie w sondzie bez HA; w dodatku tylko z opcją scan_devices
        this.devices = (devices ?? !ha) ? new net2.Devices(dir) : null;
        this.ui = ui && ha ? new UiTunnel({ haUrl: uiTarget(env), wsUrl: this.be.replace(/^http/, 'ws') + '/v1/pro/ui-agent', identity, log }) : null;
    }

    loadWatch() { try { const w = JSON.parse(fs.readFileSync(path.join(this.dir, 'pro_watch.json'), 'utf8')); return Array.isArray(w) ? w.filter(x => ENTITY_RE.test(x)).slice(0, MAX_WATCH) : []; } catch { return []; } }
    saveWatch(w) {
        const clean = [...new Set((w || []).map(String).filter(x => ENTITY_RE.test(x)))].slice(0, MAX_WATCH);
        if (clean.join(',') === this.watch.join(',')) return;
        this.watch = clean;
        try { fs.writeFileSync(path.join(this.dir, 'pro_watch.json'), JSON.stringify(clean) + '\n'); } catch {}
        this.log(`Sensmos Pro: watching ${clean.length} entities chosen in the panel`);
    }

    // Internet (5 pingów do 1.1.1.1 + DNS) najwyżej co 60 s, także w trybie szybkich raportów.
    async collectNet() {
        if (!this.netWatch) return null;
        if (Date.now() - this.netAt >= 55000 || !this.netLast) {
            this.netAt = Date.now();
            this.netLast = await (this.netFn || net2.internet)().catch(() => null);
        }
        return { internet: this.netLast, devices: this.devices ? this.devices.scan() : null };
    }

    async collect() {
        let [ha, host, lan, net] = await Promise.all([collectHa(this.ha, this.watch), collectHost(this.env), runLan(this.lan, this.lanOpts), this.collectNet()]);
        // HA bez Supervisora (Docker, Core): data ostatniej kopii z integracji backup (HA 2025.1+).
        if (ha?.backup_last && !host?.backup_newest) host = { ...(host || {}), backup_newest: ha.backup_last };
        return {
            v: 1, agent: { version: this.version, uptime_s: Math.floor((Date.now() - this.started) / 1000), mode: this.ha ? (this.env.SUPERVISOR_TOKEN ? 'addon' : 'docker') : 'probe', name: this.name || null, offline_since: this.offlineSince, control: !!this.control, account_pinned: !!this.account, caps: this.ui && this.control ? ['ui'] : [], ui_open: !!this.ui?.isOpen() },
            ha, host, lan, net,
        };
    }

    // Podpis: secp256k1/SHA256 kluczem tożsamości (ten sam co Hub/FW) z „pro|agent_id|ts|sha256(body)”.
    signed(body) {
        const ts = Math.floor(Date.now() / 1000);
        const h = crypto.createHash('sha256').update(body).digest('hex');
        return { agent_id: this.id.id, pubkey: this.id.pubHex, code: this.code, ts, body, sig: this.id.sign(`pro|${this.id.id}|${ts}|${h}`) };
    }

    async report() {
        const report = await this.collect();
        const body = JSON.stringify(report);
        let r, j = {};
        try {
            r = await fetch(this.be + '/v1/pro/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.signed(body)), signal: AbortSignal.timeout(15000) });
            try { j = await r.json(); } catch {}
        } catch (e) {
            if (!this.offlineSince) { this.offlineSince = new Date().toISOString(); this.log(`Sensmos Pro: no connection to ${this.be} (${e.message}); retrying`); }
            return { ok: false, offline: true, report };
        }
        if (this.offlineSince) { this.log(`Sensmos Pro: connection back (offline since ${this.offlineSince})`); this.offlineSince = null; }
        if (!r.ok) {
            const msg = j.error || `HTTP ${r.status}`;
            if (msg !== this.lastErr) this.log(`Sensmos Pro: the panel refused the report: ${msg}`);
            this.lastErr = msg;
            return { ok: false, status: r.status, error: msg, report };
        }
        if (this.lastErr || !this.okOnce) this.log(`Sensmos Pro: reporting to ${j.account ? 'account ' + j.account : 'the installer panel'}${j.site ? ' as "' + j.site + '"' : ''}`);
        this.lastErr = null; this.okOnce = true;
        if (Array.isArray(j.watch)) this.saveWatch(j.watch);
        if (j.account_key) this.pinAccount(j.account_key);
        if (Array.isArray(j.commands) && j.commands.length) this.runCommands(j.commands).catch(e => this.log('Sensmos Pro: commands:', e.message));
        if (Number.isFinite(j.every_s) && j.every_s >= 10 && j.every_s <= 900 && j.every_s !== this.everyS) { this.everyS = j.every_s; this.reschedule(); }
        return { ok: true, report, reply: j };
    }

    // Klucz konta instalatora (JWK P-256 {x,y}) przypinany przy pierwszej odpowiedzi BE. Inny klucz później =
    // polecenia odrzucane (zmiana konta = usunięcie pro_account.json albo ponowna instalacja dodatku u klienta).
    loadAccount() { try { const a = JSON.parse(fs.readFileSync(this.accountFile, 'utf8')); return a && a.x && a.y ? a : null; } catch { return null; } }
    pinAccount(k) {
        if (!k || typeof k.x !== 'string' || typeof k.y !== 'string') return;
        if (this.account) {
            if (this.account.x !== k.x || this.account.y !== k.y) { if (!this.keyWarned) this.log('Sensmos Pro: the installer account key changed; commands refused (reinstall the add-on to accept the new account)'); this.keyWarned = true; }
            return;
        }
        this.account = { x: k.x, y: k.y, at: new Date().toISOString() };
        try { fs.writeFileSync(this.accountFile, JSON.stringify(this.account) + '\n', { mode: 0o600 }); } catch {}
        this.log('Sensmos Pro: installer account key pinned');
    }

    // Polecenie: {id, action, args, ts, sig}; sig = ECDSA P-256/SHA-256 (format WebCrypto, hex) z
    // „pro-cmd|agent_id|id|ts|action|JSON(args)”. Zwraca powód odrzucenia albo null.
    verifyCommand(c, now = Math.floor(Date.now() / 1000)) {
        if (!this.control) return 'control disabled on this site';
        if (!this.account) return 'no installer key pinned yet';
        if (!c || !/^[A-Za-z0-9_-]{8,64}$/.test(String(c.id || ''))) return 'bad id';
        if (this.done.includes(c.id)) return 'duplicate';
        if (!Number.isInteger(c.ts) || Math.abs(now - c.ts) > CMD_MAX_AGE_S) return 'expired';
        const msg = `pro-cmd|${this.id.id}|${c.id}|${c.ts}|${c.action}|${JSON.stringify(c.args ?? {})}`;
        try {
            const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: this.account.x, y: this.account.y } });
            if (!crypto.verify('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(c.sig || ''), 'hex'))) return 'bad signature';
        } catch { return 'bad signature'; }
        return null;
    }

    async runCommands(list) {
        for (const c of list.slice(0, 10)) {
            const bad = this.verifyCommand(c);
            let res;
            if (bad) res = { id: String(c?.id || '').slice(0, 64), ok: false, error: bad };
            else {
                this.done.push(c.id); if (this.done.length > 200) this.done.shift();
                try { res = { id: c.id, ok: true, data: await this.exec(c.action, c.args || {}) }; this.log(`Sensmos Pro: installer command ${c.action} done`); }
                catch (e) { res = { id: c.id, ok: false, error: String(e.message).slice(0, 200) }; this.log(`Sensmos Pro: installer command ${c.action} failed: ${res.error}`); }
            }
            await this.postResult(res);
        }
    }

    async postResult(res) {
        const body = JSON.stringify(res);
        try { await fetch(this.be + '/v1/pro/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.signed(body)), signal: AbortSignal.timeout(15000) }); }
        catch (e) { this.log('Sensmos Pro: result not delivered:', e.message); }
    }

    async haCall(method, p, body) {
        if (!this.ha) throw new Error('no Home Assistant on this site');
        const r = await fetch(this.ha.url + p, { method, headers: { Authorization: `Bearer ${this.ha.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        const t = await r.text();
        if (!r.ok) throw new Error(`HA answered ${r.status}: ${t.slice(0, 120)}`);
        try { return JSON.parse(t); } catch { return t; }
    }

    // Jednorazowe polecenie WebSocket API HA (kopie zapasowe 2025.1+ są tylko w WS).
    haWs(type, payload = {}, timeoutMs = 30000) {
        if (!this.ha) return Promise.reject(new Error('no Home Assistant on this site'));
        const WebSocket = require('ws');
        const u = this.ha.url.replace(/^http/, 'ws') + '/api/websocket';
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(u, { handshakeTimeout: 10000 });
            const t = setTimeout(() => { ws.terminate(); reject(new Error('Home Assistant did not answer')); }, timeoutMs);
            const end = (e, v) => { clearTimeout(t); try { ws.close(); } catch {} e ? reject(e) : resolve(v); };
            ws.on('message', d => {
                let m; try { m = JSON.parse(d); } catch { return; }
                if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: this.ha.token }));
                else if (m.type === 'auth_invalid') end(new Error('Home Assistant token rejected'));
                else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type, ...payload }));
                else if (m.id === 1 && m.type === 'result') m.success ? end(null, m.result) : end(new Error(String(m.error?.message || 'HA error').slice(0, 160)));
            });
            ws.once('error', e => end(e));
        });
    }

    async localBackupAgent() {
        const info = await this.haWs('backup/agents/info');
        const ids = (info?.agents || []).map(a => a.agent_id);
        const id = ids.find(x => /\.local$/.test(x)) || ids[0];
        if (!id) throw new Error('no backup location in Home Assistant');
        return id;
    }

    async supCall(method, p, body, text = false) {
        const token = this.env.SUPERVISOR_TOKEN;
        if (!token) throw new Error('needs the Home Assistant add-on (Supervisor)');
        const r = await fetch((this.env.HUB_SUPERVISOR_URL || 'http://supervisor') + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        const t = await r.text();
        if (!r.ok) throw new Error(`Supervisor answered ${r.status}: ${t.slice(0, 120)}`);
        if (text) return t;
        try { return JSON.parse(t).data ?? null; } catch { return null; }
    }

    async exec(action, a) {
        const id = v => { const s = String(v || ''); if (!ENTITY_RE.test(s)) throw new Error('bad entity_id'); return s; };
        const slug = v => { const s = String(v || ''); if (!/^[a-z0-9_]{1,64}$/.test(s)) throw new Error('bad name'); return s; };
        switch (action) {
            case 'snapshot': {   // pełny podgląd encji na żądanie instalatora
                const st = await this.haCall('GET', '/api/states');
                return (Array.isArray(st) ? st : []).slice(0, MAX_SNAPSHOT).map(s => ({ entity_id: s.entity_id, state: String(s.state ?? '').slice(0, 64), name: String(s.attributes?.friendly_name || '').slice(0, 80), unit: s.attributes?.unit_of_measurement || null, changed: s.last_changed || null }));
            }
            case 'logs': {       // ostatnie linie logu Core (zdalny podgląd błędów)
                const t = this.env.SUPERVISOR_TOKEN ? await this.supCall('GET', '/core/logs', undefined, true) : String(await this.haCall('GET', '/api/error_log'));
                return t.split('\n').slice(-Math.min(Math.max(Number(a.lines) || 200, 10), 500)).join('\n');
            }
            case 'restart': await this.haCall('POST', '/api/services/homeassistant/restart', {}); return 'restarting';
            case 'reload_entry': { const e = String(a.entry_id || ''); if (!/^[A-Za-z0-9]{8,64}$/.test(e)) throw new Error('bad entry_id'); return this.haCall('POST', `/api/config/config_entries/entry/${e}/reload`); }
            case 'backup':
                if (!this.env.SUPERVISOR_TOKEN) {   // HA bez Supervisora (2025.1+): kopia na dysk HA przez WebSocket
                    await this.haWs('backup/generate', { agent_ids: [await this.localBackupAgent()], include_database: true, name: String(a.name || 'Sensmos Pro ' + new Date().toISOString().slice(0, 16)).slice(0, 64) });
                    return 'backup started';
                }
                await this.supCall('POST', '/backups/new/full', { name: String(a.name || 'Sensmos Pro ' + new Date().toISOString().slice(0, 16)).slice(0, 64) }); return 'backup started';
            case 'update': await this.haCall('POST', '/api/services/update/install', { entity_id: id(a.entity_id), backup: a.backup !== false }); return 'update started';
            case 'service': await this.haCall('POST', `/api/services/${slug(a.domain)}/${slug(a.service)}`, a.data && typeof a.data === 'object' ? a.data : {}); return 'ok';
            case 'automation': {  // szybka konfiguracja: automatyzacja z szablonu panelu (id = sensmos_pro_<nazwa>)
                const aid = 'sensmos_pro_' + slug(a.id);
                if (!a.config || typeof a.config !== 'object') throw new Error('config required');
                await this.haCall('POST', `/api/config/automation/config/${aid}`, { ...a.config, id: aid });
                await this.haCall('POST', '/api/services/automation/reload', {});
                return aid;
            }
            case 'ui_open': {   // pełny interfejs HA w przeglądarce instalatora (src/pro_ui.js)
                if (!this.ui) throw new Error('remote Home Assistant view is off on this site');
                if (!this.ui.ha) { let info = null; try { info = await this.supCall('GET', '/core/info'); } catch {} this.ui.setTarget(uiTarget(this.env, info || {})); }
                return this.ui.open();
            }
            case 'ui_close': return this.ui ? this.ui.close('closed in the panel') : 'not open';
            case 'devices': if (!this.devices) throw new Error('device list is off on this site (add-on option scan_devices)'); return this.devices.list();
            case 'backup_schedule': {   // szybka konfiguracja: codzienna kopia w ustawieniach kopii HA (2025.1+), 7 ostatnich
                const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(a.time || '')) ? a.time : '03:00';
                const copies = Math.min(Math.max(Number(a.copies) || 7, 1), 30);
                await this.haWs('backup/config/update', { create_backup: { agent_ids: [await this.localBackupAgent()], include_database: true }, retention: { copies }, schedule: { recurrence: 'daily', time }, automatic_backups_configured: true });
                return `daily backup at ${time}, keeping ${copies}`;
            }
            case 'fast': return 'ok';   // tylko szybsze raporty (every_s w odpowiedzi BE)
            default: throw new Error('unknown action');
        }
    }

    // Budzik: POST /v1/pro/wait wisi do 50 s i wraca od razu, gdy instalator wyśle polecenie; wtedy raport
    // odbiera polecenie bez czekania na zwykły cykl. Stary BE (404) = sprawdzaj rzadko.
    async waitLoop() {
        while (!this.stopped) {
            let pause = 0;
            try {
                const r = await fetch(this.be + '/v1/pro/wait', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.signed('{"wait":1}')), signal: AbortSignal.timeout(70000) });
                const j = await r.json().catch(() => ({}));
                if (r.ok && j.wake) await this.report().catch(() => {});
                else if (!r.ok) pause = j.error === 'unknown action' ? 600000 : 30000;   // „unknown action” = BE bez budzika
            } catch { pause = 30000; }
            if (pause && !this.stopped) await new Promise(res => { this.waitT = setTimeout(res, pause); });
        }
    }

    stopUi() { this.ui?.close('add-on stopped'); }

    reschedule() { clearInterval(this.t); this.t = setInterval(() => this.report().catch(e => this.log('Sensmos Pro:', e.message)), this.everyS * 1000); }
    start() {
        this.log(`Sensmos Pro agent ${this.version} — code ${this.code.slice(0, 3)}…${this.code.slice(-4)}, ${this.ha ? 'Home Assistant ' + this.ha.via : 'probe without Home Assistant'}, ${this.lan.length} LAN checks`);
        this.report().catch(e => this.log('Sensmos Pro:', e.message)).finally(() => { if (this.waitBell !== false) this.waitLoop(); });
        this.reschedule();
        return this;
    }
    stop() { this.stopped = true; clearInterval(this.t); clearTimeout(this.waitT); this.stopUi(); }
}

module.exports = { ProAgent, parseLan, summarizeStates, defaultGateway, runLan, collectHa, collectHost, normCode, CODE_RE };
