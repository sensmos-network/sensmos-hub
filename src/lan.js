// HTTP w LAN — to, czego używa apka przy nodzie: PIN (Bearer), /info, /config, /node/pair.
// Dane: /data/status, /data/native (format płytki, udostępnione czujniki z HA), /data/history (7 dni lokalnie).
// LoRa jak w płytce (bez radia): /lora/inbox, /node/lora_rx, /node/lorasend (przez sieć), /node/lora_emerg (puste).
// Reszta API płytki (skrypty) nie istnieje w hubie i odpowiada 404.
const http = require('http');

const LOCK_AFTER = 5, LOCK_MS = 30_000;

function start({ port, pin, identity, pairing, firmware, owner, sensors, shared, data, history, lora, connected, log, onPairingChange }) {
    const tries = new Map();   // adres → { fails, lockUntil }: blokada per nadawca, nie dla całego LAN-u
    const json = (res, code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(obj));
    };
    const checkPin = (req, res) => {
        const now = Date.now(), who = req.socket.remoteAddress || '?';
        const t = tries.get(who) || { fails: 0, lockUntil: 0 };
        if (t.lockUntil && now < t.lockUntil) { json(res, 429, { error: 'too_many_attempts' }); return false; }
        if (req.headers.authorization === `Bearer ${pin}`) { tries.delete(who); return true; }
        if (++t.fails >= LOCK_AFTER) { t.fails = 0; t.lockUntil = now + LOCK_MS; }
        tries.set(who, t);
        if (tries.size > 1000) tries.clear();
        json(res, 403, { error: 'forbidden' });
        return false;
    };
    const body = req => new Promise(resolve => {
        const chunks = [];
        req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 4096) { resolve(null); req.destroy(); } });
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
            return json(res, 200, { device_id: identity.id, firmware, hub: true, paired: pairing.has(), pubkey: identity.pubHex, ...(lora ? { lora: lora.info() } : {}) });
        }
        if (url === '/config' && req.method === 'GET') {
            if (!checkPin(req, res)) return;
            return json(res, 200, { device_id: identity.id, firmware, hub: true, remote: pairing.has() });
        }
        if (url === '/node/pair') {
            if (!checkPin(req, res)) return;
            if (req.method === 'GET') return json(res, 200, { keys: pairing.count() });
            if (req.method === 'DELETE') { pairing.clear(); onPairingChange?.(); log('pairing removed'); return json(res, 200, { status: 'ok', keys: 0 }); }
            if (req.method === 'POST') {
                const b = await body(req);
                if (!b) return json(res, 400, { error: 'bad json' });
                const hex = String(b.key || '');
                if (!/^[0-9a-fA-F]{64}$/.test(hex)) return json(res, 400, { error: 'key must be 64 hex chars' });
                if (!pairing.add(Buffer.from(hex, 'hex'))) return json(res, 400, { error: 'key rejected' });
                onPairingChange?.();
                log(`phone paired (keys: ${pairing.count()})`);
                return json(res, 200, { status: 'ok', keys: pairing.count() });
            }
        }
        // Czujniki widziane w Home Assistancie (podgląd dla apki; nic z tego nie wychodzi do sieci bez wyboru właściciela).
        if (url === '/sensors' && req.method === 'GET') {
            if (!checkPin(req, res)) return;
            const s = sensors?.() || { via: null, error: 'no Home Assistant access', count: 0, sensors: [] };
            return json(res, 200, { ...s, sensors: s.sensors.map(x => ({ ...x, shared: !!shared?.has(x.entity_id) })), shared: shared?.list() || [] });
        }
        // Dane w formacie płytki ESP32 (integracja Sensmos w HA: /data/status co 15 s, /data/native co 300 s).
        if ((url === '/data/status' || url === '/data/native') && req.method === 'GET') {
            if (!checkPin(req, res)) return;
            const d = data?.() || { status: { device_id: identity.id, buffer_count: 0, uptime_s: 0, pub: [], mon: [], own: [], pool: [] }, native: { count: 0, entities: [] } };
            return json(res, 200, url === '/data/status' ? d.status : d.native);
        }
        // Historia lokalna udostępnionych czujników (7 dni): ?entity=pub.temp_in&hours=24
        if (url === '/data/history' && req.method === 'GET') {
            if (!checkPin(req, res)) return;
            const q = new URL(req.url, 'http://h').searchParams;
            const rows = history ? history.query({ entity: q.get('entity') || null, hours: parseInt(q.get('hours')) || 24 }) : [];
            return json(res, 200, { count: rows.length, rows });
        }
        // Wybór właściciela (apka, PIN): pełna lista entity_id do udostępnienia; pusta = nic nie udostępniam.
        if (url === '/sensors/share' && req.method === 'POST') {
            if (!checkPin(req, res)) return;
            if (!shared) return json(res, 503, { error: 'no storage' });
            const b = await body(req);
            if (!b || !Array.isArray(b.shared)) return json(res, 400, { error: 'expected { shared: [entity_id, …] }' });
            let list;
            try { list = shared.set(b.shared); } catch (e) { return json(res, 500, { error: e.message }); }
            log(`sensors to share: ${list.length}${list.length ? ' (' + list.slice(0, 8).join(', ') + (list.length > 8 ? ' …' : '') + ')' : ''}`);
            return json(res, 200, { status: 'ok', shared: list });
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
        // LoRa: ramki DATA od czujników dowozi BE (ws), kafel LoRa w apce i integracja HA mówią do tych samych ścieżek co w płytce.
        if (lora && url === '/lora/inbox' && req.method === 'GET') {
            if (!checkPin(req, res)) return;
            return json(res, 200, lora.inbox());
        }
        if (lora && url === '/node/lora_rx') {
            if (!checkPin(req, res)) return;
            if (req.method === 'GET') return json(res, 200, lora.state());
            if (req.method === 'POST') {
                const b = await body(req);
                if (!b) return json(res, 400, { error: 'bad json' });
                if (b.key !== undefined && (typeof b.key !== 'string' || b.key.length > 128)) return json(res, 400, { error: 'key: text up to 128 chars' });
                return json(res, 200, lora.configure({ key: b.key, open: typeof b.open === 'boolean' ? b.open : undefined }));
            }
        }
        if (lora && url === '/node/lorasend' && req.method === 'POST') {
            if (!checkPin(req, res)) return;
            const b = await body(req);
            if (!b) return json(res, 400, { error: 'bad json' });
            const r = lora.sendData({ dst: b.dst, sub: b.sub ?? 0, payload: b.payload, aes: b.aes === true }, !!connected?.());
            return json(res, r.error ? 400 : 200, r);
        }
        if (lora && url === '/node/lora_emerg') {
            if (!checkPin(req, res)) return;
            if (req.method === 'GET') return json(res, 200, { eids: [], active: false, webhook: '', webhook_get: false });
            return json(res, 400, { error: 'no radio' });
        }
        json(res, 404, { error: 'not found' });
    });
    server.listen(port, () => log(`LAN API on port ${port}`));
    return server;
}

module.exports = { start };
