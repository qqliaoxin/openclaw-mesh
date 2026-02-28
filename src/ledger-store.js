const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { verifyPayload, accountIdFromPublicKey } = require('./wallet');

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function canonicalPayload(tx) {
    return {
        type: tx.type,
        from: tx.from || null,
        to: tx.to || null,
        amount: Number(tx.amount),
        nonce: Number(tx.nonce),
        timestamp: Number(tx.timestamp)
    };
}

class LedgerStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.dbPath = path.join(dataDir, 'ledger.sqlite');
        this.db = null;
    }

    init({ isGenesis = false, genesisAccountId = null, genesisSupply = 1000000, genesisPublicKeyPem = null, genesisPrivateKeyPem = null } = {}) {
        this.db = new Database(this.dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tx_log (
                seq INTEGER PRIMARY KEY,
                tx_id TEXT UNIQUE,
                type TEXT,
                from_account TEXT,
                to_account TEXT,
                amount REAL,
                nonce INTEGER,
                pubkey_pem TEXT,
                signature TEXT,
                timestamp INTEGER,
                status TEXT,
                reason TEXT
            );
            CREATE TABLE IF NOT EXISTS accounts_state (
                account_id TEXT PRIMARY KEY,
                balance REAL,
                nonce INTEGER
            );
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);

        if (isGenesis) {
            this.setMeta('master_pubkey', genesisPublicKeyPem);
            const existing = this.db.prepare('SELECT COUNT(1) as cnt FROM tx_log').get();
            if (existing && existing.cnt === 0) {
                if (!genesisAccountId || !genesisPublicKeyPem || !genesisPrivateKeyPem) {
                    throw new Error('Genesis wallet not configured for ledger init');
                }
                const mintTx = this.createMintTx({
                    to: genesisAccountId,
                    amount: genesisSupply,
                    nonce: 1,
                    publicKeyPem: genesisPublicKeyPem,
                    privateKeyPem: genesisPrivateKeyPem
                });
                this.appendAsMaster(mintTx);
            }
        }
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    getAccount(accountId) {
        return this.db.prepare('SELECT account_id, balance, nonce FROM accounts_state WHERE account_id = ?').get(accountId) || null;
    }

    getBalance(accountId) {
        const row = this.getAccount(accountId);
        return row ? Number(row.balance) : 0;
    }

    getNonce(accountId) {
        const row = this.getAccount(accountId);
        return row ? Number(row.nonce) : 0;
    }

    getLastSeq() {
        const row = this.db.prepare('SELECT MAX(seq) as seq FROM tx_log').get();
        return row && row.seq ? Number(row.seq) : 0;
    }

    getTxById(txId) {
        if (!txId) return null;
        return this.db.prepare(`
            SELECT seq, tx_id as txId, type, from_account as "from", to_account as "to",
                   amount, nonce, timestamp, pubkey_pem as pubkeyPem, signature
            FROM tx_log
            WHERE tx_id = ?
        `).get(txId) || null;
    }

    getConfirmations(txId) {
        const tx = this.getTxById(txId);
        if (!tx || !tx.seq) return 0;
        const lastSeq = this.getLastSeq();
        return Math.max(0, lastSeq - Number(tx.seq) + 1);
    }

    getRecentTxs(limit = 20) {
        const rows = this.db.prepare(`
            SELECT seq, tx_id as txId, type, from_account as "from", to_account as "to",
                   amount, nonce, timestamp
            FROM tx_log
            ORDER BY seq DESC
            LIMIT ?
        `).all(limit);
        return rows || [];
    }

    getMeta(key) {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    setMeta(key, value) {
        if (!key) return;
        this.db.prepare(`
            INSERT INTO meta (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value || '');
    }

    getTxLogSince(seq, limit = 500) {
        const rows = this.db.prepare(`
            SELECT seq, tx_id as txId, type, from_account as "from", to_account as "to",
                   amount, nonce, timestamp, pubkey_pem as pubkeyPem, signature
            FROM tx_log
            WHERE seq > ?
            ORDER BY seq ASC
            LIMIT ?
        `).all(seq, limit);
        return rows || [];
    }

    createTransferTx({ from, to, amount, nonce, publicKeyPem, signature }) {
        const tx = {
            type: 'transfer',
            from,
            to,
            amount: Number(amount),
            nonce: Number(nonce),
            timestamp: Date.now(),
            pubkeyPem: publicKeyPem,
            signature
        };
        tx.txId = sha256Hex(JSON.stringify({ ...canonicalPayload(tx), signature }));
        return tx;
    }

    createEscrowReleaseTx({ from, to, amount, nonce, publicKeyPem, signature }) {
        const tx = {
            type: 'escrow_release',
            from,
            to,
            amount: Number(amount),
            nonce: Number(nonce),
            timestamp: Date.now(),
            pubkeyPem: publicKeyPem,
            signature
        };
        tx.txId = sha256Hex(JSON.stringify({ ...canonicalPayload(tx), signature }));
        return tx;
    }

    createMintTx({ to, amount, nonce, publicKeyPem, privateKeyPem, signature }) {
        const tx = {
            type: 'mint',
            from: accountIdFromPublicKey(publicKeyPem),
            to,
            amount: Number(amount),
            nonce: Number(nonce),
            timestamp: Date.now(),
            pubkeyPem: publicKeyPem,
            signature: signature || null
        };
        if (!tx.signature && privateKeyPem) {
            const payload = canonicalPayload(tx);
            tx.signature = require('./wallet').signPayload(privateKeyPem, payload);
        }
        tx.txId = sha256Hex(JSON.stringify({ ...canonicalPayload(tx), signature: tx.signature }));
        return tx;
    }

    verifyTx(tx) {
        if (!tx || !tx.type || !tx.pubkeyPem || !tx.signature) {
            return { ok: false, reason: 'Missing tx fields' };
        }
        if (!Number.isFinite(tx.amount) || tx.amount <= 0) {
            return { ok: false, reason: 'Invalid amount' };
        }
        const derived = accountIdFromPublicKey(tx.pubkeyPem);
        if (tx.type === 'transfer' || tx.type === 'mint') {
            if (!tx.from || derived !== tx.from) {
                return { ok: false, reason: 'From does not match public key' };
            }
        }
        if (tx.type === 'escrow_release') {
            const masterPub = this.getMeta('master_pubkey');
            if (!masterPub || tx.pubkeyPem !== masterPub) {
                return { ok: false, reason: 'Escrow release not signed by master' };
            }
            if (!tx.from || !String(tx.from).startsWith('escrow_')) {
                return { ok: false, reason: 'Invalid escrow account' };
            }
        }
        if (!tx.to) {
            return { ok: false, reason: 'Missing to' };
        }
        const payload = canonicalPayload(tx);
        const ok = verifyPayload(tx.pubkeyPem, payload, tx.signature);
        if (!ok) {
            return { ok: false, reason: 'Invalid signature' };
        }
        return { ok: true };
    }

    appendAsMaster(tx) {
        const verification = this.verifyTx(tx);
        if (!verification.ok) {
            return { accepted: false, reason: verification.reason };
        }
        const fromAccount = this.getAccount(tx.from) || { balance: 0, nonce: 0 };
        const expectedNonce = fromAccount.nonce + 1;
        if (tx.nonce !== expectedNonce) {
            return { accepted: false, reason: 'Invalid nonce' };
        }
        if ((tx.type === 'transfer' || tx.type === 'escrow_release') && fromAccount.balance < tx.amount) {
            return { accepted: false, reason: 'Insufficient balance' };
        }
        const seq = this.getLastSeq() + 1;
        const insertTx = this.db.prepare(`
            INSERT INTO tx_log (seq, tx_id, type, from_account, to_account, amount, nonce, pubkey_pem, signature, timestamp, status, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertTx.run(
            seq,
            tx.txId,
            tx.type,
            tx.from,
            tx.to,
            tx.amount,
            tx.nonce,
            tx.pubkeyPem,
            tx.signature,
            tx.timestamp,
            'accepted',
            null
        );
        this.applyToState(tx);
        return { accepted: true, seq };
    }

    applyLogEntry(entry) {
        if (!entry || !entry.seq) {
            return { applied: false, reason: 'Missing seq' };
        }
        const exists = this.db.prepare('SELECT 1 FROM tx_log WHERE seq = ? OR tx_id = ?').get(entry.seq, entry.txId);
        if (exists) return { applied: false, reason: 'Duplicate' };
        const tx = {
            type: entry.type,
            from: entry.from,
            to: entry.to,
            amount: entry.amount,
            nonce: entry.nonce,
            timestamp: entry.timestamp,
            pubkeyPem: entry.pubkeyPem,
            signature: entry.signature,
            txId: entry.txId
        };
        if (!this.getMeta('master_pubkey') && entry.type === 'mint' && entry.pubkeyPem) {
            this.setMeta('master_pubkey', entry.pubkeyPem);
        }
        const verification = this.verifyTx(tx);
        if (!verification.ok) {
            return { applied: false, reason: verification.reason };
        }
        const insertTx = this.db.prepare(`
            INSERT INTO tx_log (seq, tx_id, type, from_account, to_account, amount, nonce, pubkey_pem, signature, timestamp, status, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertTx.run(
            entry.seq,
            entry.txId,
            entry.type,
            entry.from,
            entry.to,
            entry.amount,
            entry.nonce,
            entry.pubkeyPem,
            entry.signature,
            entry.timestamp,
            'accepted',
            null
        );
        this.applyToState(tx);
        return { applied: true };
    }

    applyToState(tx) {
        const upsert = this.db.prepare(`
            INSERT INTO accounts_state (account_id, balance, nonce)
            VALUES (?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
                balance = excluded.balance,
                nonce = excluded.nonce
        `);
        const fromState = this.getAccount(tx.from) || { balance: 0, nonce: 0 };
        const toState = this.getAccount(tx.to) || { balance: 0, nonce: 0 };
        if (tx.type === 'transfer' || tx.type === 'escrow_release') {
            if (tx.from === tx.to) {
                upsert.run(tx.from, Number(fromState.balance), Number(tx.nonce));
                return;
            }
            upsert.run(tx.from, Number(fromState.balance) - Number(tx.amount), Number(tx.nonce));
            upsert.run(tx.to, Number(toState.balance) + Number(tx.amount), Number(toState.nonce));
        } else if (tx.type === 'mint') {
            if (tx.from === tx.to) {
                upsert.run(tx.to, Number(toState.balance) + Number(tx.amount), Number(tx.nonce));
                return;
            }
            upsert.run(tx.from, Number(fromState.balance), Number(tx.nonce));
            upsert.run(tx.to, Number(toState.balance) + Number(tx.amount), Number(toState.nonce));
        }
    }
}

module.exports = LedgerStore;
