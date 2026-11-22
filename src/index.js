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
    meshtastic: !/^(0|false|no|off)$/i.test(process.env.HUB_MESHTASTIC || ''),
    meshtasticTrack: process.env.HUB_MESHTASTIC_TRACK || '',       // id nodów Meshtastic, których pozycja idzie na mapę HA
    outdoor: process.env.HUB_OUTDOOR || '',                  // czujniki HA na zewnątrz (temp_out/humidity_out), po przecinku
    lorawanForward: process.env.HUB_LORAWAN_FORWARD || '',   // host:port ChirpStacka albo TTN (Semtech UDP)
    lorawanDevaddr: process.env.HUB_LORAWAN_DEVADDR || '',   // DevAddr czujników ABP, po przecinku
    esphomeLora: process.env.HUB_ESPHOME_LORA || '',         // zwykłe ESPHome przez sieć: "nazwa=sub:hasło; …"
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
        .then(r => { console.log(`sent to ${cfg.be}: package #${r.id} (${JSON.stringify(pkg).length} B)`); process.exit(0); })
        .catch(e => { console.error('upload failed:', e.message); process.exit(1); });
    return;
}

// Sensmos Pro (dodatek „Sensmos Pro” albo Docker z HUB_MODE=pro): agent nadzoru dla instalatora, bez portfela i GALU.
// Nie startuje Huba (nie jest nodem sieci): tylko raport zdrowia HA i testy LAN do panelu sensmos.com/pro.
if (/^pro$/i.test(process.env.HUB_MODE || '') || process.env.HUB_PRO_CODE) {
    const { ProAgent } = require('./pro');
    let agent;
    try {
        agent = new ProAgent({ code: process.env.HUB_PRO_CODE, be: cfg.be, dir: cfg.data, identity: require('./identity').load(cfg.data), version: FIRMWARE.replace(/^hub-/, 'pro-'),
            ha: require('./ha').config(), lan: process.env.HUB_PRO_LAN || '', name: process.env.HUB_PRO_NAME || '', everyS: parseInt(process.env.HUB_PRO_EVERY_S) || 60,
            control: !/^(0|false|no|off)$/i.test(process.env.HUB_PRO_CONTROL || '') });
    } catch (e) { console.error(e.message); process.exit(2); }
    agent.start();
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { agent.stop(); process.exit(0); });
    return;
}

let hub;
try {
    hub = new Hub(cfg);
} catch (e) {
    console.error(e.message, '— HUB_OWNER=0x1234… in .env, or leave it empty and add the hub from the Sensmos app');
    process.exit(2);
}
hub.start();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { hub.stop(); setTimeout(() => process.exit(0), 300); });
