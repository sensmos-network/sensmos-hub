// Zwykłe ESPHome przez sieć Sensmos: ramka packet_transport złożona tak jak w esphome/components/packet_transport
// (nagłówek jawny, treść XXTEA z kluczem SHA256(hasła)). XXTEA sprawdzone z esphome/components/xxtea/xxtea.cpp (g++).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EspHomeLora, parseBoards, nameOf, decode, keyWords, xxteaEncrypt } = require('../src/esphome_lora');
const { Lora } = require('../src/lora');
const { toStates } = require('../src/ha_lora');

// Jak PacketTransport::flush_(): [MAGIC LE][len][nazwa] + zera do 4 B, treść do 4 B, XXTEA na treści.
function frame(name, records, { pass, code } = {}) {
    const head = [0x53, 0x45, name.length, ...Buffer.from(name)];
    while (head.length % 4) head.push(0);
    const d = [];
    const u32 = x => d.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255);
    if (code) { d.push(5); u32(code[0]); u32(code[1]); } else d.push(1);
    d.push(4); u32(0x11223344);                                       // klucz ping innego konsumenta: pomijany
    for (const [id, v] of records) {
        if (typeof v === 'boolean') d.push(3, v ? 1 : 0);
        else { const f = Buffer.alloc(4); f.writeFloatLE(v); d.push(2, ...f); }
        d.push(id.length, ...Buffer.from(id));
    }
    while (d.length % 4) d.push(0);
    const body = Buffer.from(d);
    if (pass) {
        const v = Array.from({ length: body.length / 4 }, (_, i) => body.readUInt32LE(4 * i));
        xxteaEncrypt(v, keyWords(pass)).forEach((w, i) => body.writeUInt32LE(w, 4 * i));
    }
    return Buffer.concat([Buffer.from(head), body]).toString('hex');
}

function hub(boards) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esph-'));
    const lora = new Lora({ dir, deviceId: 'a1b2c3d4' + '0'.repeat(56) });
    const sent = [], logs = [];
    const e = new EspHomeLora({ boards, lora, log: (...a) => logs.push(a.join(' ')), send: o => sent.push(o) });
    return { e, lora, sent, logs };
}

test('parseBoards: nazwa=sub:hasło, bez powtórek nazw i sub', () => {
    const b = parseBoards('Dzialka-Czujnik=20:moje haslo; garaz=21\n zly; x=0; dzialka-czujnik=22; y=20');
    assert.deepStrictEqual(b.map(x => [x.name, x.sub, !!x.key]), [['dzialka-czujnik', 20, true], ['garaz', 21, false]]);
});

test('ramka bez szyfrowania: wartości czujników i binarnych', () => {
    const hex = frame('garaz', [['temp', 21.5], ['door', true], ['vbat', 3.71]]);
    assert.strictEqual(nameOf(Buffer.from(hex, 'hex')), 'garaz');
    const fr = decode(Buffer.from(hex, 'hex'), null);
    assert.deepStrictEqual(fr.values, { temp: 21.5, door: 1, vbat: 3.71 });
});

test('ramka szyfrowana → sensor.sensmos_lora_<sub>_<id> w HA, claim po połączeniu', () => {
    const { e, lora, sent } = hub('dzialka-czujnik=20:moje-haslo');
    e.claim();
    assert.deepStrictEqual(sent[0], { type: 'esphome_claim', names: ['dzialka-czujnik'] });
    const seen = [];
    lora.onFrame(it => seen.push(it));
    const it = e.onWs({ hex: frame('dzialka-czujnik', [['t', -3.25], ['h', 81], ['leak', false]], { pass: 'moje-haslo', code: [7, 1] }), rx: 'c0ffee01', rssi: -118 }, 1000);
    assert.ok(it);
    assert.strictEqual(it.text, 't=-3.25;h=81;leak=0');
    assert.strictEqual(it.via, 'esphome');
    assert.strictEqual(it.rx, 'c0ffee01');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(lora.last['20'].text, 't=-3.25;h=81;leak=0');
    const ids = toStates(it).map(s => s.entity_id);
    assert.ok(ids.includes('sensor.sensmos_lora_20_t') && ids.includes('sensor.sensmos_lora_20_leak'));
    assert.strictEqual(toStates(it).find(s => s.entity_id === 'sensor.sensmos_lora_20_t').attributes.device_class, 'temperature');
});

test('powtórka: ta sama ramka od drugiego noda i stary rolling code odpadają', () => {
    const { e } = hub('dzialka-czujnik=20:moje-haslo');
    const a = frame('dzialka-czujnik', [['t', 1]], { pass: 'moje-haslo', code: [8, 1] });
    assert.ok(e.onWs({ hex: a }, 1000));
    assert.strictEqual(e.onWs({ hex: a }, 1010), null);
    assert.strictEqual(e.onWs({ hex: frame('dzialka-czujnik', [['t', 2]], { pass: 'moje-haslo', code: [5, 1] }) }, 2000), null);
    assert.ok(e.onWs({ hex: frame('dzialka-czujnik', [['t', 3]], { pass: 'moje-haslo', code: [9, 1] }) }, 2000));
});

test('zły klucz i cudza nazwa: nic nie trafia do HA, jeden wpis w logu', () => {
    const { e, lora, logs } = hub('dzialka-czujnik=20:moje-haslo');
    assert.strictEqual(e.onWs({ hex: frame('dzialka-czujnik', [['t', 1]], { pass: 'inne' }) }, 1000), null);
    assert.strictEqual(e.onWs({ hex: frame('dzialka-czujnik', [['t', 2]], { pass: 'inne' }) }, 1001), null);
    assert.strictEqual(e.onWs({ hex: frame('sasiad', [['t', 1]]) }, 1000), null);
    assert.strictEqual(logs.filter(l => l.includes('refused')).length, 1);
    assert.deepStrictEqual(lora.last, {});
});

test('id dłuższe niż 16 znaków pomijane, reszta zostaje', () => {
    const fr = decode(Buffer.from(frame('x', [['bardzo_dlugie_id_czujnika', 1], ['t', 2]]), 'hex'), null);
    assert.deepStrictEqual(fr.values, { t: 2 });
});
