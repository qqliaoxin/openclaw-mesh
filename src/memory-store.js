/**
 * MemoryStore - 记忆胶囊存储
 * 使用JSON文件存储（无需SQLite）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MemoryStore {
    constructor(dataDir = './data') {
        this.dataDir = dataDir;
        this.capsules = new Map();
        this.accounts = new Map();
        this.accountIndex = new Map();
        this.ledger = [];
        this.escrows = new Map();
        this.genesisNodeId = 'node_genesis';
        this.genesisSeed = 'genesis';
        this.genesisSupply = Number(process.env.OPENCLAW_GENESIS_SUPPLY) || 1000000;
        this.initialized = false;
    }
    
    async init() {
        // 确保数据目录存在
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        
        // 加载已有数据
        await this.loadFromDisk();
        this.ensureGenesisAccount();
        
        this.initialized = true;
        console.log(`💾 Memory store initialized: ${this.dataDir}`);
        console.log(`   Loaded ${this.capsules.size} capsules`);
    }
    
    getCapsulesPath() {
        return path.join(this.dataDir, 'capsules.json');
    }

    getAccountsPath() {
        return path.join(this.dataDir, 'accounts.json');
    }

    getLedgerPath() {
        return path.join(this.dataDir, 'ledger.json');
    }

    getEscrowPath() {
        return path.join(this.dataDir, 'escrows.json');
    }
    
    async loadFromDisk() {
        const filePath = this.getCapsulesPath();
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                for (const [key, value] of Object.entries(data)) {
                    this.capsules.set(key, value);
                }
            } catch (e) {
                console.error('Failed to load capsules:', e.message);
            }
        }

        const accountsPath = this.getAccountsPath();
        if (fs.existsSync(accountsPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
                for (const [accountId, value] of Object.entries(data.accounts || {})) {
                    this.accounts.set(accountId, value);
                }
                for (const [nodeId, accountId] of Object.entries(data.index || {})) {
                    this.accountIndex.set(nodeId, accountId);
                }
            } catch (e) {
                console.error('Failed to load accounts:', e.message);
            }
        }

        const ledgerPath = this.getLedgerPath();
        if (fs.existsSync(ledgerPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
                if (Array.isArray(data)) {
                    this.ledger = this.normalizeLedger(data);
                }
            } catch (e) {
                console.error('Failed to load ledger:', e.message);
            }
        }

        const escrowPath = this.getEscrowPath();
        if (fs.existsSync(escrowPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(escrowPath, 'utf8'));
                for (const [taskId, value] of Object.entries(data || {})) {
                    this.escrows.set(taskId, value);
                }
            } catch (e) {
                console.error('Failed to load escrows:', e.message);
            }
        }

        this.verifyLedgerIntegrity();
    }
    
    async saveToDisk() {
        const filePath = this.getCapsulesPath();
        const data = Object.fromEntries(this.capsules);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    async saveAccountsToDisk() {
        const filePath = this.getAccountsPath();
        const data = {
            accounts: Object.fromEntries(this.accounts),
            index: Object.fromEntries(this.accountIndex)
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    async saveLedgerToDisk() {
        const filePath = this.getLedgerPath();
        fs.writeFileSync(filePath, JSON.stringify(this.ledger, null, 2));
    }

    async saveEscrowsToDisk() {
        const filePath = this.getEscrowPath();
        fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(this.escrows), null, 2));
    }
    
    // 存储胶囊
    async storeCapsule(capsule) {
        // 确保有asset_id
        if (!capsule.asset_id) {
            capsule.asset_id = this.computeAssetId(capsule);
        }
        
        // 添加元数据
        if (!capsule.attribution) {
            capsule.attribution = {
                creator: 'unknown',
                created_at: new Date().toISOString()
            };
        }
        
        // 设置默认值
        capsule.status = capsule.status || 'candidate';
        capsule.type = capsule.content?.capsule?.type || 'skill';
        capsule.confidence = capsule.content?.capsule?.confidence || 0;
        
        // 存储
        this.capsules.set(capsule.asset_id, capsule);
        
        // 持久化
        await this.saveToDisk();
        
        return capsule.asset_id;
    }

    ensureAccount(nodeId, options = {}) {
        if (this.accountIndex.has(nodeId)) {
            return this.getAccountByNodeId(nodeId);
        }
        return this.createAccountWithAI(nodeId, options);
    }

    exportAccount(nodeId) {
        const account = this.getAccountByNodeId(nodeId) || this.ensureAccount(nodeId);
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            ledgerHead: this.getLedgerHeadHash(),
            account: { ...account, balance: this.computeBalance(account.accountId) }
        };
    }

    importAccount(nodeId, payload = {}) {
        if (!payload.account || !payload.account.accountId) {
            throw new Error('Invalid account payload');
        }
        const incoming = { ...payload.account };
        const existing = this.accounts.get(incoming.accountId);
        if (existing && existing.nodeId && existing.nodeId !== nodeId && !payload.force) {
            throw new Error('Account already bound to another node');
        }
        incoming.nodeId = nodeId;
        incoming.importedAt = new Date().toISOString();
        incoming.balance = 0;
        this.accounts.set(incoming.accountId, incoming);
        this.accountIndex.set(nodeId, incoming.accountId);
        this.appendLedgerEntry({
            type: 'account_imported',
            accountId: incoming.accountId,
            nodeId
        });
        this.saveAccountsToDisk();
        this.saveLedgerToDisk();
        return this.getAccountByNodeId(nodeId);
    }

    createAccountWithAI(nodeId, options = {}) {
        const algorithm = options.algorithm || 'gep-lite-v1';
        const seed = options.seed || crypto.randomBytes(16).toString('hex');
        let state = seed + nodeId;
        for (let i = 0; i < 5; i += 1) {
            state = crypto.createHash('sha256').update(state + ':' + i).digest('hex');
        }
        const accountId = 'acct_' + crypto.createHash('sha256').update(state).digest('hex').slice(0, 16);
        const account = {
            accountId,
            nodeId,
            algorithm,
            seedHash: crypto.createHash('sha256').update(seed).digest('hex'),
            createdAt: new Date().toISOString(),
            balance: 0
        };
        this.accounts.set(accountId, account);
        this.accountIndex.set(nodeId, accountId);
        this.appendLedgerEntry({
            type: 'account_created',
            accountId,
            nodeId,
            algorithm
        });
        this.saveAccountsToDisk();
        this.saveLedgerToDisk();
        return this.getAccountByNodeId(nodeId);
    }

    getAccountByNodeId(nodeId) {
        const accountId = this.accountIndex.get(nodeId);
        if (!accountId) return null;
        const account = this.accounts.get(accountId);
        if (!account) return null;
        return {
            ...account,
            balance: this.computeBalance(accountId)
        };
    }

    getBalance(nodeId) {
        const account = this.ensureAccount(nodeId);
        return account.balance || 0;
    }

    debit(nodeId, amount, meta = {}) {
        if (amount <= 0) return 0;
        const account = this.ensureAccount(nodeId);
        const balance = this.computeBalance(account.accountId);
        if (balance < amount) {
            throw new Error('Insufficient balance');
        }
        this.appendLedgerEntry({
            type: 'debit',
            accountId: account.accountId,
            nodeId,
            amount,
            meta
        });
        this.saveAccountsToDisk();
        this.saveLedgerToDisk();
        return this.computeBalance(account.accountId);
    }

    credit(nodeId, amount, meta = {}) {
        if (amount <= 0) return 0;
        const account = this.ensureAccount(nodeId);
        this.appendLedgerEntry({
            type: 'credit',
            accountId: account.accountId,
            nodeId,
            amount,
            meta
        });
        this.saveAccountsToDisk();
        this.saveLedgerToDisk();
        return this.computeBalance(account.accountId);
    }

    lockEscrow(taskId, nodeId, amount, token) {
        if (!taskId) {
            throw new Error('Invalid taskId');
        }
        if (this.escrows.has(taskId)) {
            return this.escrows.get(taskId);
        }
        this.debit(nodeId, amount, { reason: 'task_publish', taskId, token });
        const escrow = {
            taskId,
            from: nodeId,
            amount,
            token: token || 'CLAW',
            lockedAt: Date.now()
        };
        this.escrows.set(taskId, escrow);
        this.appendLedgerEntry({
            type: 'escrow_locked',
            taskId,
            from: nodeId,
            amount,
            token: token || 'CLAW'
        });
        this.saveEscrowsToDisk();
        this.saveLedgerToDisk();
        return escrow;
    }

    releaseEscrow(taskId, winnerNodeId, meta = {}) {
        const escrow = this.escrows.get(taskId);
        if (!escrow) {
            return { released: 0 };
        }
        this.escrows.delete(taskId);
        this.credit(winnerNodeId, escrow.amount, { reason: 'task_completed', taskId, token: escrow.token, ...meta });
        this.appendLedgerEntry({
            type: 'escrow_released',
            taskId,
            to: winnerNodeId,
            amount: escrow.amount,
            token: escrow.token
        });
        this.saveEscrowsToDisk();
        this.saveLedgerToDisk();
        return { released: escrow.amount };
    }

    transfer(fromNodeId, toNodeId, amount, meta = {}) {
        if (amount <= 0) return { success: false, reason: 'Invalid amount' };
        const fromAccount = this.ensureAccount(fromNodeId);
        const toAccount = this.ensureAccount(toNodeId);
        const balance = this.computeBalance(fromAccount.accountId);
        if (balance < amount) {
            throw new Error('Insufficient balance');
        }
        this.appendLedgerEntry({
            type: 'transfer',
            from: fromAccount.accountId,
            to: toAccount.accountId,
            fromNodeId,
            toNodeId,
            amount,
            meta
        });
        this.saveLedgerToDisk();
        return { success: true };
    }

    computeBalance(accountId) {
        let balance = 0;
        for (const entry of this.ledger) {
            if (entry.type === 'mint' && entry.accountId === accountId) {
                balance += entry.amount || 0;
            } else if (entry.type === 'credit' && entry.accountId === accountId) {
                balance += entry.amount || 0;
            } else if (entry.type === 'debit' && entry.accountId === accountId) {
                balance -= entry.amount || 0;
            } else if (entry.type === 'transfer') {
                if (entry.from === accountId) {
                    balance -= entry.amount || 0;
                }
                if (entry.to === accountId) {
                    balance += entry.amount || 0;
                }
            }
        }
        return balance;
    }

    ensureGenesisAccount() {
        if (this.accountIndex.has(this.genesisNodeId)) {
            const accountId = this.accountIndex.get(this.genesisNodeId);
            const minted = this.ledger.some(entry => entry.type === 'mint' && entry.accountId === accountId);
            if (!minted) {
                this.appendLedgerEntry({
                    type: 'mint',
                    accountId,
                    nodeId: this.genesisNodeId,
                    amount: this.genesisSupply
                });
                this.saveLedgerToDisk();
            }
            return;
        }
        const account = this.createAccountWithAI(this.genesisNodeId, {
            algorithm: 'genesis-v1',
            seed: this.genesisSeed
        });
        this.appendLedgerEntry({
            type: 'mint',
            accountId: account.accountId,
            nodeId: this.genesisNodeId,
            amount: this.genesisSupply
        });
        this.saveLedgerToDisk();
    }

    appendLedgerEntry(entry) {
        const prevHash = this.getLedgerHeadHash() || null;
        const index = this.ledger.length;
        const payload = {
            ...entry,
            index,
            prevHash,
            timestamp: Date.now()
        };
        const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const fullEntry = { ...payload, hash };
        this.ledger.push(fullEntry);
        return fullEntry;
    }

    getLedgerHeadHash() {
        if (this.ledger.length === 0) return null;
        return this.ledger[this.ledger.length - 1].hash || null;
    }

    normalizeLedger(entries = []) {
        const normalized = [];
        let prevHash = null;
        for (let i = 0; i < entries.length; i += 1) {
            const entry = { ...entries[i] };
            const payload = {
                ...entry,
                index: i,
                prevHash,
                timestamp: entry.timestamp || Date.now()
            };
            delete payload.hash;
            const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            normalized.push({ ...payload, hash });
            prevHash = hash;
        }
        return normalized;
    }

    verifyLedgerIntegrity() {
        let prevHash = null;
        for (let i = 0; i < this.ledger.length; i += 1) {
            const entry = this.ledger[i];
            const { hash, ...payload } = entry;
            if (payload.index !== i) {
                throw new Error('Ledger integrity check failed');
            }
            if (payload.prevHash !== prevHash) {
                throw new Error('Ledger integrity check failed');
            }
            const expected = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            if (expected !== hash) {
                throw new Error('Ledger integrity check failed');
            }
            prevHash = hash;
        }
    }
    
    // 获取胶囊
    getCapsule(assetId) {
        return this.capsules.get(assetId) || null;
    }
    
    // 查询胶囊
    queryCapsules(filter = {}) {
        let results = Array.from(this.capsules.values());
        
        if (filter.type) {
            results = results.filter(c => c.type === filter.type);
        }
        
        if (filter.creator) {
            results = results.filter(c => c.attribution?.creator === filter.creator);
        }
        
        if (filter.status) {
            results = results.filter(c => c.status === filter.status);
        }
        
        if (filter.tags && filter.tags.length > 0) {
            results = results.filter(c => {
                const tags = c.content?.capsule?.blast_radius || [];
                return filter.tags.some(tag => tags.includes(tag));
            });
        }
        
        if (filter.minConfidence) {
            results = results.filter(c => c.confidence >= filter.minConfidence);
        }
        
        // 排序
        results.sort((a, b) => b.confidence - a.confidence);
        
        if (filter.limit) {
            results = results.slice(0, filter.limit);
        }
        
        return results;
    }
    
    // 搜索记忆（简单文本搜索）
    searchMemories(query) {
        const lowerQuery = query.toLowerCase();
        const results = [];
        
        for (const capsule of this.capsules.values()) {
            const content = JSON.stringify(capsule).toLowerCase();
            if (content.includes(lowerQuery)) {
                results.push(capsule);
            }
        }
        
        return results.sort((a, b) => b.confidence - a.confidence);
    }
    
    // 获取统计
    getCount() {
        return this.capsules.size;
    }
    
    getStats() {
        const capsules = Array.from(this.capsules.values());
        const promoted = capsules.filter(c => c.status === 'promoted').length;
        const avgConfidence = capsules.length > 0 
            ? capsules.reduce((sum, c) => sum + c.confidence, 0) / capsules.length 
            : 0;
        
        return {
            total: capsules.length,
            promoted,
            avgConfidence
        };
    }
    
    // 更新胶囊状态
    updateStatus(assetId, status) {
        const capsule = this.capsules.get(assetId);
        if (capsule) {
            capsule.status = status;
            this.saveToDisk();
        }
    }
    
    // 计算asset_id
    computeAssetId(capsule) {
        const content = JSON.stringify(capsule.content);
        return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
    }
    
    // 关闭
    async close() {
        await this.saveToDisk();
        await this.saveAccountsToDisk();
        await this.saveLedgerToDisk();
        await this.saveEscrowsToDisk();
        console.log('💾 Memory store closed');
    }
}

module.exports = MemoryStore;
