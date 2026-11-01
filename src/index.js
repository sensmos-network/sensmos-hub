#!/usr/bin/env node
const path = require('path');
const { Hub } = require('./hub');

let hub;
try {
    hub = new Hub({
        be: process.env.HUB_BE || 'https://sensmos.com',
        owner: (process.env.HUB_OWNER || '').trim(),
        data: process.env.HUB_DATA || path.join(__dirname, '..', 'data'),
        port: parseInt(process.env.HUB_PORT) || 80,
        bePub: process.env.HUB_BE_PUB || undefined,
        pin: process.env.HUB_PIN || '',
    });
} catch (e) {
    console.error(e.message, '— np. HUB_OWNER=0x1234… w pliku .env');
    process.exit(2);
}
hub.start();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { hub.stop(); setTimeout(() => process.exit(0), 300); });
