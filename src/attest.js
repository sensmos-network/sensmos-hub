// Atest Huba do ceremonii nagród (BE POST /v1/attest/hub). Ten sam kanoniczny ciąg podpisuje Hub i portfel,
// więc jest w jednym miejscu: LAN /attest (apka) i polecenie WS attest_req (sensmos.com/my, iPhone bez apki).
const SEED_RE = /^[0-9a-f]{64}$/;
const COORD_RE = /^-?\d{1,3}(\.\d{1,7})?$/;

function build(deviceId, owner, seed, lat, lon) {
    return `{"v":1,"kind":"hub","device_id":"${deviceId}","owner":"${String(owner || '').toLowerCase()}","seed":"${seed}","gps_lat":"${lat}","gps_lon":"${lon}"}`;
}

// null = dobre dane, inaczej kod błędu.
function check(seed, lat, lon) {
    if (!SEED_RE.test(String(seed || ''))) return 'bad_seed';
    if (!COORD_RE.test(String(lat ?? '')) || !COORD_RE.test(String(lon ?? ''))) return 'bad_location';
    return null;
}

module.exports = { build, check };
