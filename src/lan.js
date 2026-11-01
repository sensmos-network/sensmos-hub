// HTTP w LAN — to, czego używa apka przy nodzie: PIN (Bearer), /info, /config, /node/pair.
// Reszta API płytki (dane, skrypty, LoRa) nie istnieje w hubie i odpowiada 404.
const http = require('http');

const LOCK_AFTER = 5, LOCK_MS = 30_000;

function start({ port, pin, identity, pairing, firmware, log, onPairingChange }) {
    let fails = 0, lockUntil = 0;
    const json = (res, code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(obj));
    };
    const checkPin = (req, res) => {
        const now = Date.now();
        if (lockUntil && now < lockUntil) { json(res, 429, { error: 'too_many_attempts' }); return false; }
        if (req.headers.authorization === `Bearer ${pin}`) { fails = 0; lockUntil = 0; return true; }
        if (++fails >= LOCK_AFTER) { fails = 0; lockUntil = now + LOCK_MS; }
        json(res, 403, { error: 'forbidden' });
        return false;
    };
    const body = req => new Promise(resolve => {
        const chunks = [];
        req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 4096) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); } });
        req.on('error', () => resolve(null));
    });

    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
            return res.end();
        }
        if (url === '/' || url === '/info') {
            return json(res, 200, { device_id: identity.id, firmware, hub: true, paired: pairing.has(), pubkey: identity.pubHex });
        }
        if (url === '/config' && req.method === 'GET') {
            if (!checkPin(req, res)) return;
            return json(res, 200, { device_id: identity.id, firmware, hub: true, remote: pairing.has() });
        }
        if (url === '/node/pair') {
            if (!checkPin(req, res)) return;
            if (req.method === 'GET') return json(res, 200, { keys: pairing.count() });
            if (req.method === 'DELETE') { pairing.clear(); onPairingChange?.(); log('parowanie usunięte'); return json(res, 200, { status: 'ok', keys: 0 }); }
            if (req.method === 'POST') {
                const b = await body(req);
                if (!b) return json(res, 400, { error: 'bad json' });
                const hex = String(b.key || '');
                if (!/^[0-9a-fA-F]{64}$/.test(hex)) return json(res, 400, { error: 'key must be 64 hex chars' });
                if (!pairing.add(Buffer.from(hex, 'hex'))) return json(res, 400, { error: 'key rejected' });
                onPairingChange?.();
                log(`sparowano telefon (kluczy: ${pairing.count()})`);
                return json(res, 200, { status: 'ok', keys: pairing.count() });
            }
        }
        json(res, 404, { error: 'not found' });
    });
    server.listen(port, () => log(`LAN API na porcie ${port}`));
    return server;
}

module.exports = { start };
