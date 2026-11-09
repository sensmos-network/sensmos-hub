// Pliki dodatków HA: Supervisor odrzuca cały dodatek, gdy YAML się nie parsuje (np. niezacytowany
// dwukropek w description) i dodatek znika ze sklepu bez żadnego błędu u nas. Ten test to łapie.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const root = path.join(__dirname, '..');
const parse = f => {
    const doc = YAML.parseDocument(fs.readFileSync(f, 'utf8'), { prettyErrors: true, uniqueKeys: true });
    assert.deepStrictEqual(doc.errors.map(String), [], `${path.relative(root, f)}: błąd YAML`);
    return doc.toJS();
};
const addons = fs.readdirSync(path.join(root, 'addon')).filter(d => fs.existsSync(path.join(root, 'addon', d, 'config.yaml')));

test('repository.yaml', () => {
    const r = parse(path.join(root, 'repository.yaml'));
    assert.equal(typeof r.name, 'string');
    assert.match(r.url, /^https:\/\/github\.com\//);
});

test('są dodatki', () => assert.ok(addons.length >= 1));

for (const d of addons) {
    const dir = path.join(root, 'addon', d);
    test(`addon/${d}/config.yaml`, () => {
        const c = parse(path.join(dir, 'config.yaml'));
        for (const k of ['name', 'version', 'slug', 'description']) assert.equal(typeof c[k], 'string', `${d}: ${k} musi być tekstem`);
        assert.equal(c.slug, d, 'slug = nazwa katalogu');
        assert.match(c.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
        assert.ok(Array.isArray(c.arch) && c.arch.length, 'arch');
        for (const k of Object.keys(c.options || {})) assert.ok(c.schema && k in c.schema, `${d}: opcja ${k} bez schematu`);
        const docker = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
        const m = docker.match(/ARG HUB_VERSION=v(\S+)/);
        if (m) assert.equal(m[1], c.version, `${d}: wersja w config.yaml ≠ HUB_VERSION w Dockerfile`);
    });
    const tdir = path.join(dir, 'translations');
    if (fs.existsSync(tdir)) for (const f of fs.readdirSync(tdir).filter(f => /\.ya?ml$/.test(f))) {
        test(`addon/${d}/translations/${f}`, () => {
            const t = parse(path.join(tdir, f));
            const c = parse(path.join(dir, 'config.yaml'));
            for (const k of Object.keys(t.configuration || {})) assert.ok(k in (c.options || {}), `${f}: ${k} nie ma w options`);
        });
    }
}
