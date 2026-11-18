// Plik scenariuszy dla testerów: BE (services/scenario_sync.js) przyjmuje tylko to, co tu przechodzi.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const list = require(path.join(__dirname, '..', 'scenarios', 'scenarios.json')).scenarios;

test('scenariusze: id, komponent, tytuł, kroki i punkty jak w scenario_sync BE', () => {
    const ids = new Set();
    for (const s of list) {
        assert.match(String(s.id), /^[a-z0-9-]{3,64}$/, `id ${s.id}`);
        assert.ok(!ids.has(s.id), `powtórzone id ${s.id}`); ids.add(s.id);
        assert.ok(['app', 'hub', 'fw', 'ha'].includes(s.component), `${s.id}: component ${s.component}`);
        assert.ok(s.title && s.title.en, `${s.id}: title.en`);
        assert.ok(s.steps && Array.isArray(s.steps.en), `${s.id}: steps.en`);
        if (s.points != null) assert.ok([1, 3, 10].includes(+s.points), `${s.id}: points ${s.points} (dozwolone 1, 3, 10)`);
    }
});
