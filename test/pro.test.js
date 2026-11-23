// Sensmos Pro: raport zdrowia HA, testy LAN, podpis raportu, lista obserwowanych z odpowiedzi BE, brak internetu.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pro = require('../src/pro');
const identity = require('../src/identity');

const STATES = [
    { entity_id: 'sensor.pv_power', state: '3120', attributes: { friendly_name: 'PV power', unit_of_measurement: 'W' }, last_changed: '2026-11-22T10:00:00Z' },
    { entity_id: 'sensor.modbus_heat_pump_flow', state: 'unavailable', attributes: { friendly_name: 'Heat pump flow' }, last_changed: '2026-11-22T09:00:00Z' },
    { entity_id: 'update.home_assistant_core_update', state: 'on', attributes: { title: 'Home Assistant Core', installed_version: '2026.11.1', latest_version: '2026.11.3' } },
    { entity_id: 'update.esphome', state: 'off', attributes: {} },
    { entity_id: 'light.kitchen', state: 'on', attributes: {} },
];

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

function fakeHa({ down = false } = {}) {
    return http.createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer tok') return json(res, 401, {});
        if (down) return json(res, 502, {});
        if (req.url === '/api/config') return json(res, 200, { version: '2026.11.1', state: 'RUNNING', safe_mode: false, location_name: 'Dom' });
        if (req.url === '/api/states') return json(res, 200, STATES);
        if (req.url === '/api/config/config_entries/entry') return json(res, 200, [
            { domain: 'modbus', title: 'Heat pump', state: 'setup_retry', reason: 'Connection refused' },
            { domain: 'met', title: 'Home', state: 'loaded' },
        ]);
        json(res, 404, {});
    });
}

function fakeSupervisor() {
    return http.createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer sup') return json(res, 401, {});
        const d = {
            '/host/info': { disk_total: 30, disk_used: 28.1, disk_free: 1.9, hostname: 'homeassistant' },
            '/core/info': { version: '2026.11.1', version_latest: '2026.11.3', update_available: true },
            '/os/info': { version: '16.3', version_latest: '16.3', update_available: false },
            '/supervisor/info': { version: '2026.11.0', version_latest: '2026.11.0', update_available: false, healthy: true, supported: true },
            '/backups': { backups: [{ date: '2026-11-10T03:00:00Z' }, { date: '2026-11-20T03:00:00Z' }] },
        }[req.url];
        if (!d) return json(res, 403, { result: 'error' });
        json(res, 200, { result: 'ok', data: d });
    });
}

test('parseLan: nazwa=host[:port], bez portu = ping, złe wpisy odpadają', () => {
    assert.deepStrictEqual(pro.parseLan('nas=192.168.1.5:445, drukarka=192.168.1.20:9100; router=192.168.1.1\n10.0.0.9, zly=host:99999, =, '), [
        { name: 'nas', host: '192.168.1.5', port: 445 },
        { name: 'drukarka', host: '192.168.1.20', port: 9100 },
        { name: 'router', host: '192.168.1.1', port: null },
        { name: '10.0.0.9', host: '10.0.0.9', port: null },
    ]);
    assert.deepStrictEqual(pro.parseLan(''), []);
});

test('summarizeStates: niedostępne, aktualizacje, obserwowane (także brakujące)', () => {
    const s = pro.summarizeStates(STATES, ['sensor.pv_power', 'sensor.nie_ma']);
    assert.equal(s.entities, 5);
    assert.equal(s.unavailable_count, 1);
    assert.deepStrictEqual(s.unavailable, [{ entity_id: 'sensor.modbus_heat_pump_flow', name: 'Heat pump flow', since: '2026-11-22T09:00:00Z' }]);
    assert.deepStrictEqual(s.updates, [{ entity_id: 'update.home_assistant_core_update', title: 'Home Assistant Core', installed: '2026.11.1', latest: '2026.11.3' }]);
    assert.deepStrictEqual(s.watched.map(w => [w.entity_id, w.state, w.unit]), [['sensor.pv_power', '3120', 'W'], ['sensor.nie_ma', 'missing', null]]);
});

test('defaultGateway z /proc/net/route', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pro-')), 'route');
    fs.writeFileSync(f, 'Iface\tDestination\tGateway\tFlags\n' + 'eth0\t0001A8C0\t00000000\t0001\n' + 'eth0\t00000000\t0101A8C0\t0003\n');
    assert.equal(pro.defaultGateway(f), '192.168.1.1');
    assert.equal(pro.defaultGateway('/nie/ma'), null);
});

test('runLan: port = TCP, bez portu = ping, brama dokładana na początek', async () => {
    const srv = net.createServer(s => s.end());
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
        const r = await pro.runLan([{ name: 'open', host: '127.0.0.1', port }, { name: 'p', host: '10.9.9.9', port: null }],
            { ping: async h => ({ ok: h === '192.168.1.1', ms: 3 }), gateway: '192.168.1.1' });
        assert.deepStrictEqual(r.map(x => [x.name, x.ok]), [['gateway', true], ['open', true], ['p', false]]);
        const closed = await pro.runLan([{ name: 'closed', host: '127.0.0.1', port: 1 }], { gateway: null });
        assert.equal(closed[0].ok, false);
    } finally { srv.close(); }
});

test('ProAgent: zły kod instalatora = błąd od razu', () => {
    assert.throws(() => new pro.ProAgent({ code: 'abc', dir: os.tmpdir(), identity: {}, version: 'x' }), /installer code/);
    assert.equal(pro.normCode(' sp-abcd-2345 '), 'SP-ABCD-2345');
    assert.ok(pro.CODE_RE.test('SP-ABCD-2345'));
    assert.ok(!pro.CODE_RE.test('SP-ABCD-1O00'));   // bez 0/O/1/I
});

test('ProAgent: pełny raport do BE z ważnym podpisem, lista obserwowanych z odpowiedzi', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-'));
    const id = identity.load(dir);
    const haSrv = fakeHa(), supSrv = fakeSupervisor();
    const got = [];
    const beSrv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
            got.push({ url: req.url, j: JSON.parse(b) });
            json(res, 200, { ok: true, account: 'Firma X', site: 'Dom Kowalskich', watch: ['sensor.pv_power', 'zle id!'], every_s: 60 });
        });
    });
    const [haUrl, supUrl, beUrl] = await Promise.all([listen(haSrv), listen(supSrv), listen(beSrv)]);
    const logs = [];
    try {
        const a = new pro.ProAgent({ code: 'sp-abcd-2345', be: beUrl, dir, identity: id, version: 'pro-0.3.0-beta1', ha: { url: haUrl, token: 'tok', via: 'add-on' },
            env: { SUPERVISOR_TOKEN: 'sup', HUB_SUPERVISOR_URL: supUrl }, log: m => logs.push(m), lanOpts: { gateway: null } });
        const r1 = await a.report();
        assert.ok(r1.ok);
        assert.equal(got[0].url, '/v1/pro/report');
        const p = got[0].j;
        assert.equal(p.code, 'SP-ABCD-2345');
        assert.equal(p.agent_id, id.id);
        // podpis sprawdzalny po stronie BE kluczem publicznym z raportu
        const h = crypto.createHash('sha256').update(p.body).digest('hex');
        const pub = Buffer.from(p.pubkey, 'hex');
        const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'secp256k1', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
        assert.ok(crypto.createVerify('SHA256').update(`pro|${p.agent_id}|${p.ts}|${h}`).verify(key, Buffer.from(p.sig, 'hex')));
        assert.equal(crypto.createHash('sha256').update(p.pubkey + JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8')).mac).digest('hex'), p.agent_id);
        const body = JSON.parse(p.body);
        assert.equal(body.agent.mode, 'addon');
        assert.equal(body.ha.reachable, true);
        assert.equal(body.ha.version, '2026.11.1');
        assert.equal(body.ha.unavailable_count, 1);
        assert.deepStrictEqual(body.ha.integrations_failed.map(i => i.domain), ['modbus']);
        assert.deepStrictEqual(body.ha.watched, []);                       // pierwsza wysyłka: jeszcze nic nie obserwujemy
        assert.equal(body.host.disk_free_gb, 1.9);
        assert.equal(body.host.backup_newest, '2026-11-20T03:00:00Z');
        assert.equal(body.host.core.update, true);
        // druga wysyłka: lista z panelu (złe id odfiltrowane) zapamiętana na dysku i użyta
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pro_watch.json'), 'utf8')), ['sensor.pv_power']);
        await a.report();
        const w = JSON.parse(got[1].j.body).ha.watched;
        assert.deepStrictEqual(w.map(x => [x.entity_id, x.state]), [['sensor.pv_power', '3120']]);
        assert.ok(logs.some(l => /Firma X/.test(l)));
        // nic poza wybranymi encjami: wartości innych encji nie wychodzą
        assert.ok(!got[1].j.body.includes('light.kitchen'));
    } finally { haSrv.close(); supSrv.close(); beSrv.close(); }
});

test('ProAgent: HA padło = reachable false, raport i tak idzie; odmowa BE logowana raz', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-'));
    const haSrv = fakeHa({ down: true });
    const beSrv = http.createServer((req, res) => { req.resume(); req.on('end', () => json(res, 402, { error: 'plan limit reached (2 sites)' })); });
    const [haUrl, beUrl] = await Promise.all([listen(haSrv), listen(beSrv)]);
    const logs = [];
    try {
        const a = new pro.ProAgent({ code: 'SP-ABCD-2345', be: beUrl, dir, identity: identity.load(dir), version: 'v', ha: { url: haUrl, token: 'tok', via: 'token' }, env: {}, log: m => logs.push(m), lanOpts: { gateway: null } });
        const r = await a.report(); await a.report();
        assert.equal(r.ok, false); assert.equal(r.status, 402);
        assert.equal(r.report.ha.reachable, false);
        assert.equal(r.report.host, null);
        assert.equal(r.report.agent.mode, 'docker');
        assert.equal(logs.filter(l => /refused/.test(l)).length, 1);
    } finally { haSrv.close(); beSrv.close(); }
});

test('ProAgent: brak internetu = offline_since, a po powrocie raport go niesie', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-'));
    const a = new pro.ProAgent({ code: 'SP-ABCD-2345', be: 'http://127.0.0.1:1', dir, identity: identity.load(dir), version: 'v', ha: null, env: {}, log: () => {}, lanOpts: { gateway: null } });
    const r = await a.report();
    assert.equal(r.offline, true);
    assert.ok(a.offlineSince);
    assert.equal(r.report.agent.mode, 'probe');
    assert.equal(r.report.ha, null);
});

test('polecenia: tylko podpisane przypiętym kluczem konta, świeże, bez powtórek; wykonanie przez API HA', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-'));
    const id = identity.load(dir);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const calls = [];
    const haSrv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
            calls.push([req.method, req.url, b]);
            if (req.url === '/api/states') return json(res, 200, STATES);
            if (req.url === '/api/error_log') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('l1\nERROR boom\n'); }
            json(res, 200, []);
        });
    });
    const results = [];
    let reply = { ok: true, account_key: { x: jwk.x, y: jwk.y } };
    const beSrv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
            if (req.url === '/v1/pro/result') { results.push(JSON.parse(JSON.parse(b).body)); return json(res, 200, { ok: true }); }
            json(res, 200, reply);
        });
    });
    const [haUrl, beUrl] = await Promise.all([listen(haSrv), listen(beSrv)]);
    const sign = (c, key = privateKey) => ({ ...c, sig: crypto.sign('sha256', Buffer.from(`pro-cmd|${id.id}|${c.id}|${c.ts}|${c.action}|${JSON.stringify(c.args ?? {})}`), { key, dsaEncoding: 'ieee-p1363' }).toString('hex') });
    const now = Math.floor(Date.now() / 1000);
    try {
        const a = new pro.ProAgent({ code: 'SP-ABCD-2345', be: beUrl, dir, identity: id, version: 'v', ha: { url: haUrl, token: 'tok', via: 'token' }, env: {}, log: () => {}, lanOpts: { gateway: null } });
        await a.report();
        assert.ok(a.account, 'klucz przypięty');
        const cmds = [
            sign({ id: 'cmd-restart-1', ts: now, action: 'restart', args: {} }),
            sign({ id: 'cmd-restart-1', ts: now, action: 'restart', args: {} }),                         // powtórka
            sign({ id: 'cmd-old-0001', ts: now - 3600, action: 'restart', args: {} }),                   // przeterminowane
            sign({ id: 'cmd-forged-01', ts: now, action: 'restart', args: {} }, other.privateKey),       // cudzy klucz
            { ...sign({ id: 'cmd-tamper-1', ts: now, action: 'service', args: { domain: 'light', service: 'turn_on' } }), args: { domain: 'lock', service: 'unlock' } },
            sign({ id: 'cmd-service-1', ts: now, action: 'service', args: { domain: 'light', service: 'turn_on', data: { entity_id: 'light.kitchen' } } }),
            sign({ id: 'cmd-snap-0001', ts: now, action: 'snapshot', args: {} }),
            sign({ id: 'cmd-auto-0001', ts: now, action: 'automation', args: { id: 'pv_alarm', config: { alias: 'PV alarm', trigger: [], action: [] } } }),
            sign({ id: 'cmd-logs-0001', ts: now, action: 'logs', args: {} }),                            // bez Supervisora: /api/error_log
        ];
        await a.runCommands(cmds);
        assert.deepStrictEqual(results.map(r => [r.id, r.ok, r.error || null]), [
            ['cmd-restart-1', true, null], ['cmd-restart-1', false, 'duplicate'], ['cmd-old-0001', false, 'expired'],
            ['cmd-forged-01', false, 'bad signature'], ['cmd-tamper-1', false, 'bad signature'], ['cmd-service-1', true, null],
            ['cmd-snap-0001', true, null], ['cmd-auto-0001', true, null], ['cmd-logs-0001', true, null],
        ]);
        assert.ok(calls.some(c => c[1] === '/api/services/homeassistant/restart'));
        assert.ok(!calls.some(c => c[1].startsWith('/api/services/lock')));
        assert.deepStrictEqual(JSON.parse(calls.find(c => c[1] === '/api/services/light/turn_on')[2]), { entity_id: 'light.kitchen' });
        assert.equal(results[6].data.length, STATES.length);
        assert.ok(calls.some(c => c[1] === '/api/config/automation/config/sensmos_pro_pv_alarm' && JSON.parse(c[2]).id === 'sensmos_pro_pv_alarm'));
        // podmiana klucza przez BE nie działa: przypięty zostaje stary
        reply = { ok: true, account_key: { x: other.publicKey.export({ format: 'jwk' }).x, y: other.publicKey.export({ format: 'jwk' }).y } };
        await a.report();
        assert.equal(a.account.x, jwk.x);
        assert.equal(new pro.ProAgent({ code: 'SP-ABCD-2345', dir, identity: id, version: 'v', log: () => {} }).account.x, jwk.x, 'klucz na dysku');
        // klient wyłączył sterowanie
        a.control = false;
        assert.equal(a.verifyCommand(sign({ id: 'cmd-off-00001', ts: now, action: 'restart', args: {} })), 'control disabled on this site');
    } finally { haSrv.close(); beSrv.close(); }
});
