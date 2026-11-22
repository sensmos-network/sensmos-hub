// Sensmos Pro: tunel zdalnego interfejsu HA po stronie agenta (src/pro_ui.js): podpisane połączenie z BE,
// żądania HTTP i WebSocket do HA, czyszczenie nagłówków, ścieżki tylko względne, zamknięcie po bezczynności.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocketServer } = require('ws');
const { UiTunnel, uiTarget, cleanHeaders, safePath } = require('../src/pro_ui');

test('nagłówki i ścieżki', () => {
    const h = cleanHeaders({ host: 'ha.sensmos.com', cookie: 'sp_ui=abcdefghijklmnopqrstuv; theme=dark', 'x-forwarded-for': '1.2.3.4', origin: 'https://ha.sensmos.com', 'sec-fetch-mode': 'cors', accept: 'text/html', authorization: 'Bearer x' });
    assert.deepEqual(h, { accept: 'text/html', authorization: 'Bearer x', cookie: 'theme=dark' });
    assert.equal(safePath('/api/states?x=1'), '/api/states?x=1');
    for (const bad of ['http://evil/', '//evil/x', 'api', '/a b', '/a\r\nHost: x']) assert.equal(safePath(bad), null, bad);
    assert.equal(uiTarget({}, { port: 8123, ssl: false }), 'http://127.0.0.1:8123');
    assert.equal(uiTarget({}, { port: 443, ssl: true }), 'https://127.0.0.1:443');
    assert.equal(uiTarget({ HUB_HA_URL: 'http://192.168.1.10:8123/' }), 'http://192.168.1.10:8123');
    assert.equal(uiTarget({}), null);
});

test('tunel: podpis, HTTP i WS do HA, bez X-Forwarded-For', async () => {
    const seen = [];
    const ha = http.createServer((req, res) => {
        seen.push({ url: req.url, host: req.headers.host, xff: req.headers['x-forwarded-for'], cookie: req.headers.cookie });
        let b = ''; req.on('data', c => b += c); req.on('end', () => { res.setHeader('content-type', 'text/plain'); res.end(`${req.method} ${req.url} ${b}`); });
    });
    new WebSocketServer({ server: ha }).on('connection', (ws, req) => { ws.send('auth_required ' + req.url); ws.on('message', m => ws.send('got ' + m)); });
    await new Promise(r => ha.listen(0, r));
    const be = http.createServer(); const wss = new WebSocketServer({ server: be });
    await new Promise(r => be.listen(0, r));
    const id = { id: 'a'.repeat(64), sign: m => 'sig(' + m + ')' };
    const t = new UiTunnel({ haUrl: `http://127.0.0.1:${ha.address().port}`, wsUrl: `ws://127.0.0.1:${be.address().port}/v1/pro/ui-agent`, identity: id, log: () => {} });
    const conn = new Promise(r => wss.once('connection', (ws, req) => r({ ws, url: req.url })));
    assert.equal(await t.open(), 'open');
    const { ws, url } = await conn;
    assert.match(decodeURIComponent(url), /a=a{64}&ts=\d+&sig=sig\(pro-ui\|a{64}\|\d+\)/);
    const frames = []; const wait = pred => new Promise(r => { const f = () => { const m = frames.find(pred); if (m) r(m); else setTimeout(f, 10); }; f(); });
    ws.on('message', d => frames.push(JSON.parse(d.toString())));

    ws.send(JSON.stringify({ t: 'h', id: 1, m: 'POST', p: '/api/x?y=1', h: { host: 'ha.sensmos.com', 'x-forwarded-for': '9.9.9.9', cookie: 'sp_ui=abcdefghijklmnopqrstuv; a=1' }, b: Buffer.from('ciało').toString('base64') }));
    const hr = await wait(m => m.t === 'hr' && m.id === 1);
    assert.equal(hr.s, 200);
    await wait(m => m.t === 'he' && m.id === 1);
    const body = Buffer.concat(frames.filter(m => m.t === 'hd' && m.id === 1).map(m => Buffer.from(m.d, 'base64'))).toString();
    assert.equal(body, 'POST /api/x?y=1 ciało');
    assert.deepEqual(seen[0], { url: '/api/x?y=1', host: `127.0.0.1:${ha.address().port}`, xff: undefined, cookie: 'a=1' });

    ws.send(JSON.stringify({ t: 'h', id: 2, m: 'GET', p: 'http://evil/' }));
    assert.equal((await wait(m => m.t === 'he' && m.id === 2)).err, 'refused');

    ws.send(JSON.stringify({ t: 'wo', id: 3, p: '/api/websocket', h: {} }));
    assert.equal((await wait(m => m.t === 'wo' && m.id === 3)).ok, true);
    assert.equal((await wait(m => m.t === 'wm' && m.id === 3)).d, 'auth_required /api/websocket');
    ws.send(JSON.stringify({ t: 'wm', id: 3, d: 'hello' }));
    await wait(m => m.t === 'wm' && m.id === 3 && m.d === 'got hello');

    t.idleMs = 0; t.checkIdle();
    assert.equal(t.isOpen(), false, 'bezczynność zamyka tunel');
    assert.equal(t.streams.size, 0);
    ha.close(); be.close(); wss.close(); for (const c of wss.clients) c.terminate();
});
