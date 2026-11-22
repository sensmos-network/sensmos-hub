// Sensmos Pro: zdalny interfejs HA klienta (pełne UI Home Assistanta w przeglądarce instalatora).
// Tunel otwiera WYŁĄCZNIE agent, po poleceniu ui_open podpisanym kluczem konta instalatora (P-256, jak inne
// polecenia). Agent łączy się wtedy z BE (wss …/v1/pro/ui-agent, podpis secp256k1 „pro-ui|agent_id|ts”),
// a BE przekazuje mu żądania HTTP i WebSocket z osobnej domeny (np. ha.sensmos.com). Logowanie robi samo HA
// (konto instalatora u klienta). Tunel zamyka się po bezczynności (domyślnie 30 min), po ui_close albo po
// maks. czasie (8 h). Klient wyłącza go opcją allow_remote_ui=false.
//
// Ramki (JSON tekstowy, treść base64):
//   BE → agent: {t:'h', id, m, p, h, b?}   żądanie HTTP (b = całe ciało)
//               {t:'wo', id, p, h}          otwarcie WebSocketa do HA
//               {t:'wm', id, d, bin}        wiadomość WS do HA
//               {t:'wc', id}                zamknięcie WS / przerwanie żądania
//   agent → BE: {t:'hr', id, s, h}  nagłówek odpowiedzi; {t:'hd', id, d} kawałek; {t:'he', id, err?} koniec
//               {t:'wo', id, ok, err?}; {t:'wm', id, d, bin}; {t:'wc', id}
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const IDLE_MS = 30 * 60 * 1000;
const MAX_MS = 8 * 60 * 60 * 1000;
const MAX_STREAMS = 128;
const HIGH_WATER = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
    'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'origin', 'referer',
    'content-length', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'cookie']);
const DROP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'trailer', 'strict-transport-security', 'alt-svc']);

// Cookie przechodzą do HA bez naszego „sp_ui” (sesja proxy jest sprawą BE, HA jej nie zobaczy).
function cleanHeaders(h = {}) {
    const out = {};
    for (const [k, v] of Object.entries(h)) {
        const key = k.toLowerCase();
        if (DROP_REQ.has(key) || key.startsWith('sec-fetch') || typeof v !== 'string') continue;
        out[key] = v;
    }
    const cookie = String(h.cookie || h.Cookie || '').split(';').map(s => s.trim()).filter(s => s && !s.startsWith('sp_ui=')).join('; ');
    if (cookie) out.cookie = cookie;
    return out;
}

function resHeaders(h = {}) {
    const out = {};
    for (const [k, v] of Object.entries(h)) if (!DROP_RES.has(k.toLowerCase())) out[k.toLowerCase()] = v;
    return out;
}

// Ścieżka tylko względna, bez schematu i hosta (żądanie zawsze idzie do HA tego klienta).
function safePath(p) {
    const s = String(p || '/');
    if (!s.startsWith('/') || s.startsWith('//') || /[\r\n\s]/.test(s) || s.length > 4096) return null;
    return s;
}

class UiTunnel {
    // haUrl: http(s)://homeassistant:8123 (dodatek) albo HUB_HA_URL (Docker); wsUrl: wss://sensmos.com/v1/pro/ui-agent
    constructor({ haUrl, wsUrl, identity, log = console.log, idleMs = IDLE_MS, maxMs = MAX_MS, WS = WebSocket }) {
        this.ha = haUrl ? new URL(haUrl) : null; this.wsUrl = wsUrl; this.id = identity; this.log = log;
        this.idleMs = idleMs; this.maxMs = maxMs; this.WS = WS;
        this.ws = null; this.streams = new Map(); this.opened = 0; this.last = 0; this.timer = null;
    }

    setTarget(u) { this.ha = new URL(u); }

    isOpen() { return !!this.ws && this.ws.readyState === 1; }

    open() {
        if (!this.ha) return Promise.reject(new Error('no Home Assistant address'));
        if (this.ws && this.ws.readyState <= 1) { this.last = Date.now(); return Promise.resolve('already open'); }
        const ts = Math.floor(Date.now() / 1000);
        const sig = this.id.sign(`pro-ui|${this.id.id}|${ts}`);
        const u = `${this.wsUrl}?a=${encodeURIComponent(this.id.id)}&ts=${ts}&sig=${sig}`;
        return new Promise((resolve, reject) => {
            const ws = new this.WS(u, { handshakeTimeout: 15000, maxPayload: 32 * 1024 * 1024 });
            this.ws = ws;
            ws.once('open', () => {
                this.opened = this.last = Date.now();
                clearInterval(this.timer);
                this.timer = setInterval(() => this.checkIdle(), 30000);
                this.log('Sensmos Pro: remote Home Assistant view opened by the installer');
                resolve('open');
            });
            ws.on('message', (data, isBin) => { if (!isBin) this.onFrame(data.toString()); });
            ws.once('error', e => { if (!this.opened) reject(new Error('panel tunnel: ' + e.message)); });
            ws.once('close', () => { this.cleanup(); });
        });
    }

    checkIdle() {
        const now = Date.now();
        if (now - this.last > this.idleMs) this.close('idle');
        else if (now - this.opened > this.maxMs) this.close('time limit');
    }

    close(why = 'closed') {
        if (!this.ws) return 'not open';
        try { this.send({ t: 'bye' }); this.ws.close(1000, why); } catch {}
        this.log(`Sensmos Pro: remote Home Assistant view closed (${why})`);
        this.cleanup();
        return 'closed';
    }

    cleanup() {
        clearInterval(this.timer); this.timer = null;
        for (const s of this.streams.values()) { try { s.req?.destroy(); s.ws?.terminate(); } catch {} }
        this.streams.clear();
        this.ws = null; this.opened = 0;
    }

    send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

    onFrame(text) {
        let m; try { m = JSON.parse(text); } catch { return; }
        if (!m || typeof m !== 'object') return;
        this.last = Date.now();
        const id = m.id | 0;
        switch (m.t) {
            case 'h': return this.httpReq(id, m);
            case 'wo': return this.wsOpen(id, m);
            case 'wm': { const s = this.streams.get(id); if (s?.ws && s.ws.readyState === 1) s.ws.send(m.bin ? Buffer.from(m.d || '', 'base64') : String(m.d ?? '')); return; }
            case 'wc': { const s = this.streams.get(id); if (s) { this.streams.delete(id); try { s.req?.destroy(); s.ws?.close(); } catch {} } return; }
            case 'bye': return this.close('closed in the panel');
        }
    }

    httpReq(id, m) {
        const p = safePath(m.p);
        if (!p || this.streams.size >= MAX_STREAMS || this.streams.has(id)) return this.send({ t: 'he', id, err: 'refused' });
        const body = m.b ? Buffer.from(m.b, 'base64') : null;
        const headers = cleanHeaders(m.h);
        headers.host = this.ha.host;
        if (/text\/html/.test(headers.accept || '')) delete headers['accept-encoding'];   // strona HTML bez kompresji: BE dokleja pasek obiektu
        if (body) headers['content-length'] = String(body.length);
        const lib = this.ha.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: this.ha.hostname, port: this.ha.port || (this.ha.protocol === 'https:' ? 443 : 80), method: String(m.m || 'GET').toUpperCase(), path: p, headers, rejectUnauthorized: false, timeout: 60000 }, res => {
            this.send({ t: 'hr', id, s: res.statusCode, h: resHeaders(res.headers) });
            res.on('data', buf => {
                for (let i = 0; i < buf.length; i += CHUNK) this.send({ t: 'hd', id, d: buf.subarray(i, i + CHUNK).toString('base64') });
                if (this.ws && this.ws.bufferedAmount > HIGH_WATER) {
                    res.pause();
                    const t = setInterval(() => { if (!this.ws || this.ws.bufferedAmount < HIGH_WATER / 4) { clearInterval(t); res.resume(); } }, 50);
                }
            });
            res.once('end', () => { this.streams.delete(id); this.send({ t: 'he', id }); });
            res.once('error', e => { this.streams.delete(id); this.send({ t: 'he', id, err: e.message }); });
        });
        this.streams.set(id, { req });
        req.once('timeout', () => req.destroy(new Error('Home Assistant did not answer')));
        req.once('error', e => { if (this.streams.has(id)) { this.streams.delete(id); this.send({ t: 'he', id, err: e.message }); } });
        req.end(body || undefined);
    }

    wsOpen(id, m) {
        const p = safePath(m.p);
        if (!p || this.streams.size >= MAX_STREAMS || this.streams.has(id)) return this.send({ t: 'wo', id, ok: false, err: 'refused' });
        const base = (this.ha.protocol === 'https:' ? 'wss://' : 'ws://') + this.ha.host;
        const proto = String(m.h?.['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean);
        const ws = new this.WS(base + p, proto, { headers: cleanHeaders(m.h), rejectUnauthorized: false, handshakeTimeout: 15000, maxPayload: 32 * 1024 * 1024 });
        this.streams.set(id, { ws });
        ws.once('open', () => this.send({ t: 'wo', id, ok: true, proto: ws.protocol || undefined }));
        ws.on('message', (data, isBin) => { this.last = Date.now(); this.send(isBin ? { t: 'wm', id, d: Buffer.from(data).toString('base64'), bin: true } : { t: 'wm', id, d: data.toString() }); });
        ws.once('error', e => { if (ws.readyState !== 1) this.send({ t: 'wo', id, ok: false, err: e.message }); });
        ws.once('close', () => { if (this.streams.delete(id)) this.send({ t: 'wc', id }); });
    }
}

// Adres interfejsu HA dla tunelu: HUB_PRO_UI_URL, w Dockerze HUB_HA_URL; w dodatku (host_network) port i SSL
// z Supervisora (GET /core/info) na 127.0.0.1. null = trzeba zapytać Supervisora.
function uiTarget(env = process.env, coreInfo = null) {
    if (env.HUB_PRO_UI_URL) return env.HUB_PRO_UI_URL.replace(/\/$/, '');
    if (env.HUB_HA_URL) return env.HUB_HA_URL.replace(/\/$/, '');
    if (coreInfo) return `${coreInfo.ssl ? 'https' : 'http'}://127.0.0.1:${Number(coreInfo.port) || 8123}`;
    return null;
}

module.exports = { UiTunnel, uiTarget, cleanHeaders, resHeaders, safePath };
