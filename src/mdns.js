// mDNS jak w FW (wifi_manager.cpp): host `sensmos-<6 znaków device_id>.local`, usługa `_sensmos._tcp`
// z TXT device_id i version oraz `_http._tcp`. Apka znajduje tak noda w LAN przy parowaniu.
const { Bonjour } = require('bonjour-service');

function start({ deviceId, port, firmware, log }) {
    const host = `sensmos-${deviceId.slice(0, 6)}`;
    const b = new Bonjour();
    const txt = { device_id: deviceId, version: firmware };
    const s1 = b.publish({ name: host, type: 'sensmos', port, host: `${host}.local`, txt });
    const s2 = b.publish({ name: host, type: 'http', port, host: `${host}.local`, txt });
    s1.on('up', () => log(`mDNS: ${host}.local (_sensmos._tcp, port ${port})`));
    s1.on('error', e => log('mDNS:', e.message));
    s2.on('error', () => {});
    return { stop: () => new Promise(r => b.unpublishAll(() => { b.destroy(); r(); })) };
}

module.exports = { start };
