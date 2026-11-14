// Hub bez HUB_OWNER: czeka na apkę (PIN w powiadomieniu HA), przypisanie po LAN (POST /node/owner) rejestruje i łączy,
// drugi portfel dostaje odmowę, przypisanie przeżywa restart.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Hub } = require('../src/hub');

const OWNER = '0x5Cb314D83f0b15ACa87cAeA920f242A4D19a3Dd0';
const OTHER = '0x' + '2'.repeat(40);

// Atrapa BE: rejestracja + WS, który na identify odpowiada bez kanału (wystarczy, że hub się łączy).
function fakeBe() {
    const reg = [], ids = [];
    const srv = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/register') {
            let b = ''; req.on('data', c => b += c); req.on('end', () => { reg.push(JSON.parse(JSON.parse(b).message)); res.writeHead(200); res.end('{"status":"ok"}'); });
            return;
        }
        res.writeHead(404); res.end();
    });
    const wss = new WebSocket.Server({ server: srv, path: '/v1/ws' });
    wss.on('connection', ws => ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'identify') ids.push(m.device_id); } catch {} }));
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, wss, reg, ids, url: `http://127.0.0.1:${srv.address().port}` })));
}

// Atrapa HA: zapisuje wywołania persistent_notification.
function fakeHa() {
    const calls = [];
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => { calls.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/api/states' ? '[]' : '[]'); });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, calls, cfg: { url: `http://127.0.0.1:${srv.address().port}`, token: 't0k', via: 'token' } })));
}

const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };

test('Hub bez właściciela: czeka, PIN w HA, przypisanie z apki, odmowa dla drugiego portfela, restart pamięta', async () => {
    const be = await fakeBe(), haSrv = await fakeHa();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-owner-'));
    const mk = () => new Hub({ be: be.url, data: dir, port: 0, pin: '123456', pingS: 3600, checkS: 3600, backoffS: 0.2, mdns: false, ha: haSrv.cfg, loraHa: false, log: () => {} });
    let hub = mk(), hub2;
    try {
        await hub.start();
        const lan = `http://127.0.0.1:${hub.lan.address().port}`;
        await new Promise(r => setTimeout(r, 150));
        assert.strictEqual(be.reg.length, 0, 'bez właściciela nie ma rejestracji');
        assert.strictEqual(be.ids.length, 0, 'bez właściciela nie ma połączenia z siecią');
        await until(() => haSrv.calls.some(c => c.url.endsWith('/persistent_notification/create')));
        const n = haSrv.calls.find(c => c.url.endsWith('/create'));
        assert.strictEqual(n.auth, 'Bearer t0k');
        assert.strictEqual(n.body.notification_id, 'sensmos_hub_pin');
        assert.match(n.body.message, /123456/);

        let info = await (await fetch(lan + '/info')).json();
        assert.strictEqual(info.owner_set, false);

        const post = (owner, pin = '123456') => fetch(lan + '/node/owner', { method: 'POST', headers: { Authorization: `Bearer ${pin}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }) });
        assert.strictEqual((await post(OWNER, '000000')).status, 403, 'bez PIN-u nic');
        assert.strictEqual((await post('0x123')).status, 400);
        const ok = await post(OWNER);
        assert.strictEqual(ok.status, 200);
        assert.deepStrictEqual(await ok.json(), { status: 'ok', owner: OWNER.toLowerCase() });
        assert.strictEqual(be.reg.length, 1);
        assert.strictEqual(be.reg[0].owner.toLowerCase(), OWNER.toLowerCase());
        await until(() => be.ids.includes(hub.id.id));
        assert.ok(haSrv.calls.some(c => c.url.endsWith('/persistent_notification/dismiss')), 'powiadomienie z PIN-em zdjęte');
        info = await (await fetch(lan + '/info')).json();
        assert.strictEqual(info.owner_set, true);

        assert.strictEqual((await post(OWNER.toLowerCase())).status, 200, 'ten sam portfel ponownie = ok');
        const no = await post(OTHER);
        assert.strictEqual(no.status, 409);
        assert.deepStrictEqual(await no.json(), { error: 'owner_set' });
        assert.strictEqual(be.reg.length, 1, 'drugi portfel nie rejestruje');

        hub.stop();
        hub2 = mk();
        assert.strictEqual(hub2.cfg.owner.toLowerCase(), OWNER.toLowerCase(), 'owner.json po restarcie');
    } finally {
        hub.stop(); hub2?.stop();
        be.wss.close(); be.srv.close(); haSrv.srv.close();
    }
});

test('HUB_OWNER ze zmiennej nadal działa, zły adres = błąd startu', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-owner-'));
    assert.throws(() => new Hub({ owner: '0x12', data: dir, mdns: false, log: () => {} }), /HUB_OWNER/);
    const h = new Hub({ owner: OWNER, data: dir, mdns: false, log: () => {} });
    assert.strictEqual(h.cfg.owner, OWNER);
    h.events.stop();
});
