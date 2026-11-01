// Joby checknetu (check_jobs od BE) → rekordy `measure` (kontrakt/protokol/measure.md).
// icmp przez systemowy `ping` (bez surowych gniazd w Node), tcp/http/dns natywnie, trace pomijany.
const { execFile } = require('child_process');
const net = require('net');
const dns = require('dns').promises;
const os = require('os');

const PING_TIMEOUT_S = 2;

function ping(host, count) {
    const win = os.platform() === 'win32';
    const args = win ? ['-n', String(count), '-w', String(PING_TIMEOUT_S * 1000), host]
                     : ['-n', '-c', String(count), '-W', String(PING_TIMEOUT_S), '-i', '0.2', host];
    return new Promise(resolve => {
        execFile('ping', args, { timeout: (count + 2) * PING_TIMEOUT_S * 1000 }, (err, stdout) => {
            const out = String(stdout || '');
            const loss = out.match(/(\d+(?:[.,]\d+)?)%/);
            const rtt = win ? out.match(/=\s*(\d+)ms[^=]*=\s*(\d+)ms[^=]*=\s*(\d+)ms/)
                            : out.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/);
            if (!loss && !rtt) return resolve(err && err.code === 'ENOENT' ? null : { ok: false, loss: 100, n: count });
            const lossPct = loss ? parseFloat(loss[1].replace(',', '.')) : 100;
            const r = rtt ? (win ? { rtt: +rtt[3], jit: Math.max(0, (+rtt[2] - +rtt[1]) / 2) } : { rtt: +rtt[2], jit: +rtt[4] }) : null;
            resolve({ ok: !!r && lossPct < 100, loss: lossPct, n: count, ...(r || {}) });
        });
    });
}

function tcp(host, port, timeoutMs) {
    return new Promise(resolve => {
        const t0 = process.hrtime.bigint();
        const s = net.connect({ host, port, timeout: timeoutMs });
        const done = ok => { s.destroy(); resolve(ok ? { ok: true, rtt: Number(process.hrtime.bigint() - t0) / 1e6 } : { ok: false }); };
        s.once('connect', () => done(true));
        s.once('timeout', () => done(false));
        s.once('error', () => done(false));
    });
}

async function http(job, timeoutMs) {
    const url = `${job.https === false ? 'http' : 'https'}://${job.host}${job.port ? ':' + job.port : ''}${job.path || '/'}`;
    const t0 = process.hrtime.bigint();
    try {
        const r = await fetch(url, { method: job.method || 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const ok = job.expected_status ? r.status === job.expected_status : r.status < 400;
        return { ok, rtt: ms, x: { status_code: r.status, ...(ok ? { ttfb_ms: ms } : {}) } };
    } catch { return { ok: false, x: { status_code: 0 } }; }
}

async function dnsJob(job, timeoutMs) {
    const t0 = process.hrtime.bigint();
    try {
        const ips = await Promise.race([dns.resolve4(job.host), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
        const rtt = Number(process.hrtime.bigint() - t0) / 1e6;
        const match = job.expected ? ips.includes(job.expected) : true;
        return { ok: ips.length > 0, rtt, x: { resolved_ip: ips[0] || '', match } };
    } catch { return { ok: false }; }
}

function defaultGateway() {
    return new Promise(resolve => {
        if (os.platform() === 'win32') return resolve(null);
        execFile('ip', ['route', 'show', 'default'], (err, out) => {
            const m = String(out || '').match(/default via (\S+)/);
            resolve(m ? m[1] : null);
        });
    });
}

// → tablica rekordów `measure` (joby, których hub nie umie zmierzyć, są pomijane)
async function run(jobs) {
    const out = [];
    for (const j of jobs || []) {
        const kind = j.kind || 'icmp';
        const gw = j.target_kind === 'gateway';
        const timeoutMs = j.timeout_ms || 4000;
        let host = j.host || '';
        if (gw && !host) host = await defaultGateway();
        if (!host) continue;
        let r;
        if (kind === 'icmp') r = await ping(host, j.count || 4);
        else if (kind === 'tcp') r = await tcp(host, j.port || 443, timeoutMs);
        else if (kind === 'http') r = await http({ ...j, host }, timeoutMs);
        else if (kind === 'dns') r = await dnsJob({ ...j, host }, timeoutMs);
        else continue;
        if (!r) continue;
        const rec = { kind: `net.${gw ? 'lan' : kind}`, target: host, tk: j.target_kind || 'target', ok: r.ok };
        if (r.rtt != null) rec.rtt = +r.rtt.toFixed(1);
        if (r.jit != null) rec.jit = +r.jit.toFixed(1);
        if (r.loss != null) rec.loss = r.loss;
        if (r.n != null) rec.n = r.n;
        rec.x = { to_region: j.to_region || 'ANY', to_lat: j.to_lat ?? null, to_lon: j.to_lon ?? null, ...(r.x || {}) };
        out.push(rec);
    }
    return out.slice(0, 64);
}

module.exports = { run, ping, tcp };
