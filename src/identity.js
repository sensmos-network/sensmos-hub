// Tożsamość hubu: klucz secp256k1 i „MAC” w pliku data/identity.json. device_id = sha256(pubkey_hex + mac)
// tak samo jak w FW (identity.cpp), więc BE nie odróżnia hubu od płytki po samym id.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function load(dir) {
    const file = path.join(dir, 'identity.json');
    let j;
    if (fs.existsSync(file)) {
        j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
        j = { priv: crypto.randomBytes(32).toString('hex'), mac: crypto.randomBytes(6).toString('hex') };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(j) + '\n', { mode: 0o600 });
    }
    const priv = Buffer.from(j.priv, 'hex');
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(priv);
    const pub = ecdh.getPublicKey();
    const pubHex = pub.toString('hex');
    const id = crypto.createHash('sha256').update(pubHex + j.mac).digest('hex');
    const key = crypto.createPrivateKey({ format: 'jwk', key: {
        kty: 'EC', crv: 'secp256k1', d: priv.toString('base64url'),
        x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    return {
        id, pub, pubHex, ecdh,
        sign: str => crypto.createSign('SHA256').update(str).sign(key).toString('hex'),
    };
}

module.exports = { load };
