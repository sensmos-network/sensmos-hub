// HTTP w LAN — to, czego używa apka przy nodzie: PIN (Bearer), /info, /config, /node/pair.
// Reszta API płytki (dane, skrypty, LoRa) nie istnieje w hubie i odpowiada 404.
const http = require('http');

const LOCK_AFTER = 5, LOCK_MS = 30_000;

function start({ port, pin, identity, pairing, firmware, owner, sensors, log, onPairingChange }) {
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
        // Czujniki widziane w Home Assistancie (podgląd dla apki; nic z tego nie wychodzi do sieci bez wyboru właściciela).
        if (url === '/sensors' && req.method === 'GET') {
            if (!checkPin(req, res)) return;
            const s = sensors?.();
            return json(res, 200, s || { via: null, error: 'no Home Assistant access', count: 0, sensors: [] });
        }
        // Ceremonia LAN (nagrody Huba, BE /v1/attest/hub): apka w tej samej sieci przynosi seed z BE i pozycję
        // telefonu, Hub podpisuje kanoniczny atest SWOIM device_id i SWOIM właścicielem — nie jest wyrocznią
        // do podpisywania dowolnych ciągów. Ten sam ciąg podpisuje potem portfel.
        if (url === '/attest' && req.method === 'POST') {
            if (!checkPin(req, res)) return;
            const b = await body(req);
            const seed = String(b?.seed || ''), lat = String(b?.gps_lat ?? ''), lon = String(b?.gps_lon ?? '');
            if (!/^[0-9a-f]{64}$/.test(seed)) return json(res, 400, { error: 'seed must be 64 hex chars' });
            if (!/^-?\d{1,3}(\.\d{1,7})?$/.test(lat) || !/^-?\d{1,3}(\.\d{1,7})?$/.test(lon)) return json(res, 400, { error: 'gps_lat/gps_lon as decimal strings' });
            const attest = `{"v":1,"kind":"hub","device_id":"${identity.id}","owner":"${String(owner || '').toLowerCase()}","seed":"${seed}","gps_lat":"${lat}","gps_lon":"${lon}"}`;
            log('atest LAN podpisany dla apki (nagrody Huba)');
            return json(res, 200, { attest, sig: identity.sign(attest), device_id: identity.id });
        }
        json(res, 404, { error: 'not found' });
    });
    server.listen(port, () => log(`LAN API na porcie ${port}`));
    return server;
}

module.exports = { start };
