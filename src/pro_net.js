// Sensmos Pro dla informatyków: sprawdzanie stron i usług (HTTP + data wygaśnięcia certyfikatu), jakość internetu
// (utrata pakietów, opóźnienie, DNS) i spis urządzeń w sieci z tablicy ARP (nowe urządzenie = alarm przez 24 h).
// Wszystko lokalnie w sieci klienta; do panelu idą tylko wyniki. Funkcje czyste tam, gdzie się da (testy).
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const NEW_DEVICE_H = 24, MAX_DEVICES = 1024, MAX_NEW = 20;

// HTTP(S): status i czas odpowiedzi; dla https także dni do wygaśnięcia certyfikatu i czy jest zaufany.
// Certyfikat własny (drukarka, NAS, router) nie oznacza awarii: strona działa, panel pokaże „niezaufany”.
async function httpCheck(url, { timeoutMs = 8000, getFn = nodeGet } = {}) {
    const t0 = Date.now();
    const out = { ok: false, ms: null, status: null };
    try {
        const r = await getFn(url, timeoutMs);
        out.status = r.status; out.ms = Date.now() - t0; out.ok = r.status < 400;
        if (r.cert) { out.cert_days = r.cert.days; out.cert_trusted = r.cert.trusted; }
    } catch (e) { out.error = String(e.code || e.name || e.message).slice(0, 60); }
    return out;
}

// GET bez pobierania treści, do 3 przekierowań; certyfikat z pierwszego połączenia https.
// agent: false = nowe połączenie bez wznawiania sesji TLS (przy wznowionej sesji Node nie podaje certyfikatu).
function nodeGet(url, timeoutMs = 8000, hops = 3, cert = null) {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request(u, { method: 'GET', agent: false, rejectUnauthorized: false, timeout: timeoutMs, headers: { 'user-agent': 'SensmosPro-probe/1' } }, res => {
            let c = cert;
            if (!c && u.protocol === 'https:' && res.socket.getPeerCertificate) {
                const pc = res.socket.getPeerCertificate();
                if (pc && pc.valid_to) c = { days: Math.floor((new Date(pc.valid_to) - Date.now()) / 86400000), trusted: !!res.socket.authorized };
            }
            res.resume();
            const loc = res.headers.location;
            if (res.statusCode >= 300 && res.statusCode < 400 && loc && hops > 0) {
                let next; try { next = new URL(loc, u).toString(); } catch { return resolve({ status: res.statusCode, cert: c }); }
                return nodeGet(next, timeoutMs, hops - 1, c).then(resolve, reject);
            }
            resolve({ status: res.statusCode, cert: c });
        });
        req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
        req.once('error', reject);
        req.end();
    });
}

// „5 packets transmitted, 4 received, 20% packet loss … rtt min/avg/max/mdev = 9.1/12.3/20.0/3.1 ms” → {loss, ms}
function parsePing(text) {
    const loss = String(text).match(/([\d.]+)% packet loss/);
    const rtt = String(text).match(/= [\d.]+\/([\d.]+)\//);
    return { loss: loss ? Number(loss[1]) : 100, ms: rtt ? Math.round(Number(rtt[1])) : null };
}

function pingMany(host, count = 5, { tcpFn = tcpRtt } = {}) {
    return new Promise(resolve => {
        execFile('ping', ['-c', String(count), '-i', '0.2', '-W', '2', host], { timeout: 10000 }, (err, stdout) => {
            // Brak ping albo brak uprawnień (np. kontener bez NET_RAW): zamiast fałszywego „100% strat” mierzymy połączenia TCP.
            if (err && !/packet loss/.test(String(stdout || ''))) return tcpMany(host, count, tcpFn).then(resolve);
            resolve(parsePing(stdout || ''));
        });
    });
}

async function tcpMany(host, count, tcpFn) {
    const ms = [];
    for (let i = 0; i < count; i++) { const t = await tcpFn(host, 443).catch(() => null); if (t != null) ms.push(t); }
    return { loss: Math.round((count - ms.length) / count * 100), ms: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, via: 'tcp' };
}

function tcpRtt(host, port, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const t0 = process.hrtime.bigint();
        const s = net.connect({ host, port, timeout: timeoutMs }, () => { s.destroy(); resolve(Number(process.hrtime.bigint() - t0) / 1e6); });
        s.once('timeout', () => { s.destroy(); reject(new Error('timeout')); });
        s.once('error', reject);
    });
}

async function dnsCheck(name = 'sensmos.com', timeoutMs = 4000) {
    const t0 = Date.now();
    try {
        await Promise.race([dns.promises.resolve4(name), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
        return { ok: true, ms: Date.now() - t0 };
    } catch { return { ok: false, ms: null }; }
}

async function internet({ ping = pingMany, dnsFn = dnsCheck } = {}) {
    const [p, d] = await Promise.all([ping('1.1.1.1'), dnsFn()]);
    return { loss: p.loss, ms: p.ms, ...(p.via ? { via: p.via } : {}), dns_ok: d.ok, dns_ms: d.ms, ok: p.loss < 100 && d.ok };
}

// /proc/net/arp: „IP address HW type Flags HW address Mask Device”; flaga 0x2 = wpis pełny.
function parseArp(text) {
    const out = [];
    for (const line of String(text).split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 6 || f[2] !== '0x2' || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(f[3]) || f[3] === '00:00:00:00:00:00') continue;
        out.push({ ip: f[0], mac: f[3].toLowerCase(), dev: f[5] });
    }
    return out;
}

// Spis urządzeń: plik pro_devices.json {mac: {ip, first, last}}. Pierwszy odczyt = stan wyjściowy (bez alarmów).
class Devices {
    constructor(dir, { arpFile = '/proc/net/arp', now = () => Date.now() } = {}) {
        this.file = path.join(dir, 'pro_devices.json'); this.arpFile = arpFile; this.now = now;
        try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.db = null; }
    }
    scan() {
        let arp = [];
        try { arp = parseArp(fs.readFileSync(this.arpFile, 'utf8')); } catch { return null; }
        const t = this.now(), baseline = !this.db;
        if (baseline) this.db = {};
        for (const d of arp) {
            const e = this.db[d.mac];
            if (e) { e.ip = d.ip; e.last = t; }
            else if (Object.keys(this.db).length < MAX_DEVICES) this.db[d.mac] = { ip: d.ip, first: t, last: t, ...(baseline ? { base: 1 } : {}) };
        }
        try { fs.writeFileSync(this.file, JSON.stringify(this.db) + '\n'); } catch {}
        const fresh = Object.entries(this.db).filter(([, e]) => !e.base && t - e.first < NEW_DEVICE_H * 3600000)
            .map(([mac, e]) => ({ mac, ip: e.ip, first: new Date(e.first).toISOString() })).slice(0, MAX_NEW);
        return { now: arp.length, known: Object.keys(this.db).length, new: fresh };
    }
    list() {
        const t = this.now();
        return Object.entries(this.db || {}).map(([mac, e]) => ({ mac, ip: e.ip, first: new Date(e.first).toISOString(), last: new Date(e.last).toISOString(), online: t - e.last < 10 * 60000 }))
            .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    }
}

module.exports = { httpCheck, nodeGet, tcpMany, parsePing, pingMany, dnsCheck, internet, parseArp, Devices };
