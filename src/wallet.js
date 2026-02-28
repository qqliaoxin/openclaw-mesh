const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function accountIdFromPublicKey(publicKeyPem) {
    const hash = sha256Hex(publicKeyPem);
    return `acct_${hash.slice(0, 16)}`;
}

function loadOrCreateWallet(dataDir) {
    const walletPath = path.join(dataDir, 'wallet.json');
    if (fs.existsSync(walletPath)) {
        const raw = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
        return {
            walletPath,
            publicKeyPem: raw.publicKeyPem,
            privateKeyPem: raw.privateKeyPem,
            accountId: raw.accountId
        };
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const accountId = accountIdFromPublicKey(publicKeyPem);
    const payload = { publicKeyPem, privateKeyPem, accountId, createdAt: new Date().toISOString() };
    fs.writeFileSync(walletPath, JSON.stringify(payload, null, 2));
    return { walletPath, publicKeyPem, privateKeyPem, accountId };
}

function importWallet(dataDir, payload = {}) {
    const walletPath = path.join(dataDir, 'wallet.json');
    const source = payload.account || payload || {};
    const privateKeyPem = source.privateKeyPem || source.privateKey || payload.privateKeyPem;
    if (!privateKeyPem) {
        throw new Error('Missing privateKeyPem in import payload');
    }
    const privateKeyObj = crypto.createPrivateKey(privateKeyPem);
    const derivedPublicKeyPem = crypto.createPublicKey(privateKeyObj).export({ type: 'spki', format: 'pem' });
    const publicKeyPem = source.publicKeyPem || payload.publicKeyPem || derivedPublicKeyPem;
    if (publicKeyPem.trim() !== derivedPublicKeyPem.trim()) {
        throw new Error('Public key does not match private key');
    }
    const expectedAccountId = accountIdFromPublicKey(publicKeyPem);
    const accountId = source.accountId || payload.accountId || expectedAccountId;
    if (accountId !== expectedAccountId) {
        throw new Error('AccountId does not match public key');
    }
    const payloadToWrite = {
        publicKeyPem,
        privateKeyPem,
        accountId,
        importedAt: new Date().toISOString()
    };
    fs.writeFileSync(walletPath, JSON.stringify(payloadToWrite, null, 2));
    return { walletPath, publicKeyPem, privateKeyPem, accountId };
}

function signPayload(privateKeyPem, payload) {
    const message = Buffer.from(JSON.stringify(payload));
    const signature = crypto.sign(null, message, privateKeyPem);
    return signature.toString('base64');
}

function verifyPayload(publicKeyPem, payload, signatureBase64) {
    const message = Buffer.from(JSON.stringify(payload));
    return crypto.verify(null, message, publicKeyPem, Buffer.from(signatureBase64, 'base64'));
}

module.exports = {
    loadOrCreateWallet,
    signPayload,
    verifyPayload,
    accountIdFromPublicKey,
    importWallet
};
