#!/usr/bin/env node
const path = require('path');
const { Hub, FIRMWARE } = require('./hub');

const cfg = {
    be: process.env.HUB_BE || 'https://sensmos.com',
    owner: (process.env.HUB_OWNER || '').trim(),
    data: process.env.HUB_DATA || path.join(__dirname, '..', 'data'),
    port: parseInt(process.env.HUB_PORT) || 80,
    bePub: process.env.HUB_BE_PUB || undefined,
    pin: process.env.HUB_PIN || '',
    loraKey: process.env.HUB_LORA_KEY || '',
    loraHa: !/^(0|false|no|off)$/i.test(process.env.HUB_LORA_HA || ''),
};

// `diag`: paczka diagnostyczna z katalogu danych (działa też obok uruchomionego hubu).
if (process.argv[2] === 'diag') {
    const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
    const { build, upload } = require('./diag');
    const identity = require('./identity').load(cfg.data);
    const { Pairing } = require('./tunnel');
    const pkg = build({ dir: cfg.data, identity, firmware: FIRMWARE, cfg, pairingCount: new Pairing(cfg.data).count(), scenario: arg('scenario') });
    if (!process.argv.includes('--upload')) { process.stdout.write(JSON.stringify(pkg, null, 2) + '\n'); process.exit(0); }
    upload({ be: cfg.be, identity, pkg, result: arg('result'), note: arg('note') })
        .then(r => { console.log(`wysłano do ${cfg.be}: paczka #${r.id} (${JSON.stringify(pkg).length} B)`); process.exit(0); })
        .catch(e => { console.error('wysyłka nieudana:', e.message); process.exit(1); });
    return;
}

let hub;
try {
    hub = new Hub(cfg);
} catch (e) {
    console.error(e.message, '— np. HUB_OWNER=0x1234… w pliku .env');
    process.exit(2);
}
hub.start();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { hub.stop(); setTimeout(() => process.exit(0), 300); });
