// Historia udostępnionych czujników na dysku Huba (plan bramy, temat 4): 7 dni, lokalnie, bez serwera.
// data/history.jsonl — jedna linia na odczyt: {"t":<unix s>,"e":"pub.temp_in","v":21.4,"u":"°C"}.
// Przycinanie przy dopisywaniu, gdy plik urośnie — rzadko, żeby nie przepisywać pliku co 5 minut.
const fs = require('fs');
const path = require('path');

const KEEP_S = 7 * 86400;

class History {
    constructor(dir, { keepS = KEEP_S, pruneEvery = 288, log = () => {} } = {}) {
        this.file = path.join(dir, 'history.jsonl');
        this.keepS = keepS; this.pruneEvery = pruneEvery; this.writes = 0; this.log = log;
        try { if (fs.existsSync(this.file)) this.prune(); } catch (e) { this.log(`history: ${e.message}`); }   // restart nie zeruje przycinania
    }

    append(entities, now = Math.floor(Date.now() / 1000)) {
        if (!entities.length) return;
        try {
            const lines = entities.map(e => JSON.stringify({ t: now, e: e.entity_id, v: e.value, u: e.unit || '' })).join('\n') + '\n';
            fs.appendFileSync(this.file, lines);
            if (++this.writes % this.pruneEvery === 0) this.prune(now);
        } catch (e) { this.log(`history: write failed (${e.message})`); }   // pełny dysk / tylko do odczytu nie kładzie Huba
    }

    rows() {
        let txt = '';
        try { txt = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
        const out = [];
        for (const l of txt.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
        return out;
    }

    prune(now = Math.floor(Date.now() / 1000)) {
        const keep = this.rows().filter(r => r.t >= now - this.keepS);
        fs.writeFileSync(this.file, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
        return keep.length;
    }

    // Odczyt dla apki / integracji: jedna encja albo wszystkie, z ostatnich `hours` godzin.
    query({ entity = null, hours = 24, now = Math.floor(Date.now() / 1000), limit = 5000 } = {}) {
        const from = now - Math.min(Math.max(hours, 1), 168) * 3600;
        const out = this.rows().filter(r => r.t >= from && (!entity || r.e === entity)).map(r => ({ t: r.t, e: r.e, v: r.v, u: r.u }));
        return out.length > limit ? out.slice(-limit) : out;   // najnowsze; bez tego 200 czujników × 7 dni = MB w jednej odpowiedzi
    }
}

module.exports = { History, KEEP_S };
