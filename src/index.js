/**
 * OpenClaw Mesh - 去中心化技能共享网络
 * Main Entry Point
 */

const MeshNode = require('./node');
const MemoryStore = require('./memory-store');
const TaskBazaar = require('./task-bazaar');
const WebUIServer = require('../web/server');
const TaskWorker = require('./task-worker');
const LedgerStore = require('./ledger-store');
const { loadOrCreateWallet, signPayload, accountIdFromPublicKey } = require('./wallet');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class OpenClawMesh {
    constructor(options = {}) {
        this.options = {
            nodeId: options.nodeId || this.generateNodeId(),
            port: options.port || 0,
            bootstrapNodes: options.bootstrapNodes || [],
            dataDir: options.dataDir || './data',
            webPort: options.webPort || 3457,
            isGenesisNode: options.isGenesisNode ?? process.env.OPENCLAW_IS_GENESIS === '1',
            masterUrl: options.masterUrl || process.env.OPENCLAW_MASTER_URL || null,
            genesisOperatorAccountId: options.genesisOperatorAccountId || process.env.OPENCLAW_GENESIS_OPERATOR || null,
            capsulePriceDefault: Number(options.capsulePriceDefault ?? process.env.OPENCLAW_CAPSULE_PRICE ?? 10),
            capsuleCreatorShare: Number(options.capsuleCreatorShare ?? process.env.OPENCLAW_CAPSULE_CREATOR_SHARE ?? 0.9),
            capsulePublishFee: Number(options.capsulePublishFee ?? process.env.OPENCLAW_CAPSULE_PUBLISH_FEE ?? 1),
            taskPublishFee: Number(options.taskPublishFee ?? process.env.OPENCLAW_TASK_PUBLISH_FEE ?? 0),
            txConfirmations: options.txConfirmations || {
                transfer: 1,
                capsulePublish: 1,
                capsulePurchase: 1,
                taskPublish: 1,
                taskEscrow: 1
            },
            txTimeoutMs: options.txTimeoutMs || {
                transfer: 8000,
                capsulePublish: 8000,
                capsulePurchase: 8000,
                taskPublish: 8000,
                taskEscrow: 8000
            },
            ...options
        };
        
        this.node = null;
        this.memoryStore = null;
        this.taskBazaar = null;
        this.webUI = null;
        this.ledger = null;
        this.wallet = null;
        this.initialized = false;
    }
    
    generateNodeId() {
        const crypto = require('crypto');
        return 'node_' + crypto.randomBytes(8).toString('hex');
    }
    
    async init() {
        console.log(`🚀 Initializing OpenClaw Mesh...`);
        console.log(`   Node ID: ${this.options.nodeId}`);
        
        // 初始化存储
        this.memoryStore = new MemoryStore(this.options.dataDir, {
            nodeId: this.options.nodeId,
            isGenesisNode: this.options.isGenesisNode,
            masterUrl: this.options.masterUrl,
            genesisOperatorAccountId: this.options.genesisOperatorAccountId
        });
        await this.memoryStore.init();
        this.wallet = loadOrCreateWallet(this.options.dataDir);
        this.ledger = new LedgerStore(this.options.dataDir);
        this.ledger.init({
            isGenesis: this.options.isGenesisNode,
            genesisAccountId: this.wallet.accountId,
            genesisSupply: this.memoryStore.genesisSupply,
            genesisPublicKeyPem: this.wallet.publicKeyPem,
            genesisPrivateKeyPem: this.wallet.privateKeyPem
        });
        
        // 初始化P2P节点
        this.node = new MeshNode({
            nodeId: this.options.nodeId,
            port: this.options.port,
            bootstrapNodes: this.options.bootstrapNodes
        });
        await this.node.init();

        // 账本广播由主节点处理 tx -> tx_log
        
        // 初始化任务市场
        this.taskBazaar = new TaskBazaar({
            nodeId: this.options.nodeId,
            memoryStore: this.memoryStore,
            ledger: this.ledger,
            walletAccountId: this.wallet.accountId
        });
        
        // 初始化任务处理器 (自动争单)
        this.taskWorker = new TaskWorker(this);
        this.taskWorker.startAutoBidding();
        
        // 初始化WebUI
        this.webUI = new WebUIServer({
            port: this.options.webPort,
            mesh: this
        });
        await this.webUI.start();
        
        // 设置事件监听
        this.setupEventHandlers();
        
        this.initialized = true;
        console.log(`✅ OpenClaw Mesh initialized successfully!`);
        console.log(`   WebUI: http://localhost:${this.options.webPort}`);
        
        return this;
    }

    setupEventHandlers() {
        // 监听新记忆
        this.node.on('memory:received', async (capsule) => {
            console.log(`📦 New capsule received: ${capsule.asset_id}`);
            await this.memoryStore.storeCapsule(capsule);
        });
        
        // 监听新任务
        this.node.on('task:received', async (task) => {
            console.log(`🎯 New task received: ${task.taskId}`);
            await this.taskBazaar.handleNewTask(task);
        });
        
        // 监听任务竞价
        this.node.on('task:bid', async (payload) => {
            try {
                if (!payload) return;
                const { taskId, bid } = payload;
                console.log(`💰 Bid received for task: ${taskId?.slice(0, 16)} from ${bid?.nodeId?.slice(0, 16)}`);
                if (taskId && bid) {
                    const task = this.taskBazaar.getTask(taskId);
                    if (task) {
                        if (task.status === 'assigned' || task.status === 'completed') {
                            return;
                        }
                        task.bids = task.bids || [];
                        // Avoid duplicate bids
                        if (!task.bids.find(b => b.nodeId === bid.nodeId)) {
                            task.bids.push(bid);
                            this.taskBazaar.updateTask(taskId, { 
                                bids: task.bids,
                                status: task.status === 'open' ? 'voting' : task.status,
                                votingStartedAt: task.votingStartedAt || bid.timestamp || Date.now()
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('Error handling task:bid:', err.message);
            }
        });

        this.node.on('task:assigned', async (payload) => {
            try {
                if (!payload) return;
                const { taskId, assignedTo, assignedAt } = payload;
                if (!taskId || !assignedTo) return;
                const updatedTask = this.taskBazaar.updateTask(taskId, { 
                    status: 'assigned',
                    assignedTo,
                    assignedAt: assignedAt || Date.now()
                });
                if (this.taskWorker?.biddingTasks) {
                    this.taskWorker.biddingTasks.delete(taskId);
                }
                if (assignedTo === this.options.nodeId && updatedTask) {
                    await this.taskWorker.startWorkingOnTask(updatedTask);
                }
            } catch (err) {
                console.error('Error handling task:assigned:', err.message);
            }
        });
        
        // 监听任务完成
        this.node.on('task:completed', async (payload) => {
            try {
                if (!payload) return;
                const { taskId, nodeId, result, package: taskPackage } = payload;
                console.log(`✅ Task completed by node: ${nodeId?.slice(0, 16)} for task: ${taskId?.slice(0, 16)}`);
                if (taskId) {
                    this.taskBazaar.updateTask(taskId, { 
                        status: 'completed',
                        completedBy: nodeId,
                        completedAt: result?.completedAt || Date.now(),
                        result
                    });
                }
                if (taskId && nodeId && taskPackage?.data) {
                    const completedBasePath = path.join(path.resolve(__dirname, '..'), 'task-workspace', 'completed');
                    const completedDir = path.join(completedBasePath, `${nodeId}_${taskId}`);
                    await fs.mkdir(completedDir, { recursive: true });
                    const fileName = taskPackage.fileName || (taskId + '.zip');
                    const zipPath = path.join(completedDir, fileName);
                    const zipBuffer = Buffer.from(taskPackage.data, 'base64');
                    await fs.writeFile(zipPath, zipBuffer);
                }
            } catch (err) {
                console.error('Error handling task:completed:', err.message);
            }
        });
        
        // 监听节点连接
        this.node.on('peer:connected', (peerId) => {
            console.log(`🌐 Peer connected: ${peerId}`);
            if (!this.options.isGenesisNode) {
                const lastSeq = this.ledger.getLastSeq();
                this.node.sendToPeer(peerId, {
                    type: 'tx_log_request',
                    payload: { sinceSeq: lastSeq },
                    timestamp: Date.now()
                });
            }
        });
        
        // 监听节点断开
        this.node.on('peer:disconnected', (peerId) => {
            console.log(`🔌 Peer disconnected: ${peerId}`);
        });
        
        // 监听交易广播
        this.node.on('tx:received', (tx) => {
            if (!tx) return;
            if (this.options.isGenesisNode) {
                const result = this.ledger.appendAsMaster(tx);
                if (result.accepted) {
                    this.node.broadcastAll({
                        type: 'tx_log',
                        payload: {
                            seq: result.seq,
                            txId: tx.txId,
                            type: tx.type,
                            from: tx.from,
                            to: tx.to,
                            amount: tx.amount,
                            nonce: tx.nonce,
                            timestamp: tx.timestamp,
                            pubkeyPem: tx.pubkeyPem,
                            signature: tx.signature
                        },
                        timestamp: Date.now()
                    });
                }
            }
        });
        
        // 监听交易日志同步
        this.node.on('tx:log', (entry) => {
            if (!entry) return;
            this.ledger.applyLogEntry(entry);
            if (this.taskBazaar?.tryActivatePendingTasks) {
                this.taskBazaar.tryActivatePendingTasks();
            }
        });

        // 监听账本同步请求（仅主节点响应）
        this.node.on('tx:log_request', (payload, peerId) => {
            if (!this.options.isGenesisNode) return;
            const sinceSeq = Number(payload?.sinceSeq || 0);
            const entries = this.ledger.getTxLogSince(sinceSeq);
            if (entries.length === 0) return;
            this.node.sendToPeer(peerId, {
                type: 'tx_log_batch',
                payload: { entries },
                timestamp: Date.now()
            });
        });

        // 监听账本批量同步
        this.node.on('tx:log_batch', (payload) => {
            const entries = payload?.entries || [];
            for (const entry of entries) {
                this.ledger.applyLogEntry(entry);
            }
            if (this.taskBazaar?.tryActivatePendingTasks) {
                this.taskBazaar.tryActivatePendingTasks();
            }
        });
    }
    
    createSignedTransfer(toAccountId, amount) {
        const nonce = this.ledger.getNonce(this.wallet.accountId) + 1;
        const payload = {
            type: 'transfer',
            from: this.wallet.accountId,
            to: toAccountId,
            amount: Number(amount),
            nonce,
            timestamp: Date.now()
        };
        const signature = signPayload(this.wallet.privateKeyPem, payload);
        return {
            ...payload,
            pubkeyPem: this.wallet.publicKeyPem,
            signature,
            txId: crypto.createHash('sha256').update(JSON.stringify({ ...payload, signature })).digest('hex')
        };
    }

    getPlatformAccountId() {
        const masterPub = this.ledger.getMeta('master_pubkey');
        if (!masterPub) return null;
        return accountIdFromPublicKey(masterPub);
    }

    async waitForPlatformAccount(timeoutMs = 8000, intervalMs = 200) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const platform = this.getPlatformAccountId();
            if (platform) return platform;
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return null;
    }

    async waitForTxConfirmations(txId, target = 1, timeoutMs = 8000, intervalMs = 200) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const confirmations = this.ledger.getConfirmations(txId);
            if (confirmations >= target) {
                return { confirmed: true, confirmations };
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return { confirmed: false, confirmations: this.ledger.getConfirmations(txId) };
    }

    getConfirmConfig(action) {
        const target = this.options.txConfirmations?.[action] ?? 1;
        const timeoutMs = this.options.txTimeoutMs?.[action] ?? 8000;
        return { target, timeoutMs };
    }

    getTxStatus(txId) {
        const confirmations = this.ledger.getConfirmations(txId);
        return { txId, confirmations, confirmed: confirmations > 0 };
    }

    createSignedEscrowRelease(escrowAccountId, toAccountId, amount) {
        const nonce = this.ledger.getNonce(escrowAccountId) + 1;
        const payload = {
            type: 'escrow_release',
            from: escrowAccountId,
            to: toAccountId,
            amount: Number(amount),
            nonce,
            timestamp: Date.now()
        };
        const signature = signPayload(this.wallet.privateKeyPem, payload);
        return {
            ...payload,
            pubkeyPem: this.wallet.publicKeyPem,
            signature,
            txId: crypto.createHash('sha256').update(JSON.stringify({ ...payload, signature })).digest('hex')
        };
    }

    getEscrowAccountId(taskId) {
        const hash = crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 24);
        return `escrow_${hash}`;
    }

    submitTx(tx) {
        if (!tx) return { submitted: false, reason: 'Missing tx' };
        if (this.options.isGenesisNode) {
            const result = this.ledger.appendAsMaster(tx);
            if (result.accepted) {
                this.node.broadcastAll({
                    type: 'tx_log',
                    payload: {
                        seq: result.seq,
                        txId: tx.txId,
                        type: tx.type,
                        from: tx.from,
                        to: tx.to,
                        amount: tx.amount,
                        nonce: tx.nonce,
                        timestamp: tx.timestamp,
                        pubkeyPem: tx.pubkeyPem,
                        signature: tx.signature
                    },
                    timestamp: Date.now()
                });
            }
            return { ...result, txId: tx.txId };
        }
        this.node.broadcastAll({
            type: 'tx',
            payload: tx,
            timestamp: Date.now()
        });
        return { submitted: true, txId: tx.txId };
    }

    // 发布记忆胶囊
    async publishCapsule(capsule) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        
        if (!capsule.price) {
            capsule.price = {
                amount: this.options.capsulePriceDefault,
                token: 'CLAW',
                creatorShare: this.options.capsuleCreatorShare
            };
        } else if (typeof capsule.price.creatorShare !== 'number') {
            capsule.price.creatorShare = this.options.capsuleCreatorShare;
        }

        // 添加创建者信息
        const creator = capsule.attribution?.creator || this.options.nodeId;
        capsule.attribution = {
            creator,
            created_at: new Date().toISOString()
        };
        
        // 计算asset_id
        capsule.asset_id = this.computeAssetId(capsule);

        const txReceipts = [];
        if (this.options.capsulePublishFee > 0) {
            const feeAmount = Number(this.options.capsulePublishFee);
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < feeAmount) {
                throw new Error('Insufficient balance to publish capsule');
            }
            const platformAccountId = await this.waitForPlatformAccount();
            if (!platformAccountId) {
                throw new Error('Platform account not available yet');
            }
            const feeTx = this.createSignedTransfer(platformAccountId, feeAmount);
            const feeResult = this.submitTx(feeTx);
            if (this.options.isGenesisNode && !feeResult.accepted) {
                throw new Error(feeResult.reason || 'Failed to pay publish fee');
            }
            const cfg = this.getConfirmConfig('capsulePublish');
            const feeConfirm = await this.waitForTxConfirmations(feeTx.txId, cfg.target, cfg.timeoutMs);
            txReceipts.push({ txId: feeTx.txId, ...feeConfirm });
        }
        
        // 本地存储
        await this.memoryStore.storeCapsule(capsule);
        
        // 广播到网络
        const capsuleMeta = {
            ...capsule,
            content: null,
            contentHash: capsule.asset_id
        };
        await this.node.broadcastCapsule(capsuleMeta);
        
        console.log(`✅ Capsule published: ${capsule.asset_id}`);
        return { assetId: capsule.asset_id, txReceipts };
    }
    
    // 发布任务
    async publishTask(task) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        
        task.publisher = task.publisher || this.options.nodeId;
        task.published_at = new Date().toISOString();
        task.taskId = this.computeTaskId(task);
        task.escrowAccountId = this.getEscrowAccountId(task.taskId);

        const txReceipts = [];
        if (this.options.taskPublishFee > 0) {
            const feeAmount = Number(this.options.taskPublishFee);
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < feeAmount) {
                throw new Error('Insufficient balance to publish task');
            }
            const platformAccountId = await this.waitForPlatformAccount();
            if (!platformAccountId) {
                throw new Error('Platform account not available yet');
            }
            const feeTx = this.createSignedTransfer(platformAccountId, feeAmount);
            const feeResult = this.submitTx(feeTx);
            if (this.options.isGenesisNode && !feeResult.accepted) {
                throw new Error(feeResult.reason || 'Failed to pay task publish fee');
            }
            const cfg = this.getConfirmConfig('taskPublish');
            const feeConfirm = await this.waitForTxConfirmations(feeTx.txId, cfg.target, cfg.timeoutMs);
            txReceipts.push({ type: 'task_publish_fee', txId: feeTx.txId, ...feeConfirm });
        }

        const bountyAmount = Number(task.bounty?.amount || 0);
        if (bountyAmount > 0) {
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < bountyAmount) {
                throw new Error('Insufficient balance to lock escrow');
            }
            const escrowTx = this.createSignedTransfer(task.escrowAccountId, bountyAmount);
            const escrowResult = this.submitTx(escrowTx);
            if (this.options.isGenesisNode && !escrowResult.accepted) {
                throw new Error(escrowResult.reason || 'Failed to lock escrow');
            }
            const cfg = this.getConfirmConfig('taskEscrow');
            const escrowConfirm = await this.waitForTxConfirmations(escrowTx.txId, cfg.target, cfg.timeoutMs);
            txReceipts.push({ type: 'task_escrow_lock', txId: escrowTx.txId, ...escrowConfirm });
        }

        const taskId = await this.taskBazaar.publishTask(task);
        await this.node.broadcastTask(task);
        console.log(`🎯 Task published: ${taskId}`);
        return { taskId, txReceipts };
    }

    async purchaseCapsule(assetId, buyerNodeId = null) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        const buyer = buyerNodeId || this.options.nodeId;
        const capsule = this.memoryStore.getCapsule(assetId);
        if (!capsule) {
            throw new Error('Capsule not found');
        }
        const price = capsule.price?.amount || 0;
        if (price > 0 && buyer !== capsule.attribution?.creator) {
            const share = typeof capsule.price?.creatorShare === 'number' ? capsule.price.creatorShare : this.options.capsuleCreatorShare;
            const creatorAmount = Math.floor(price * share);
            const platformAmount = price - creatorAmount;
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < price) {
                throw new Error('Insufficient balance to purchase capsule');
            }
            const platformAccountId = await this.waitForPlatformAccount();
            if (!platformAccountId) {
                throw new Error('Platform account not available yet');
            }
            const txReceipts = [];
            const toCreatorTx = creatorAmount > 0 ? this.createSignedTransfer(capsule.attribution.creator, creatorAmount) : null;
            const toPlatformTx = platformAmount > 0 ? this.createSignedTransfer(platformAccountId, platformAmount) : null;
            if (toCreatorTx) {
                const res1 = this.submitTx(toCreatorTx);
                if (this.options.isGenesisNode && !res1.accepted) {
                    throw new Error(res1.reason || 'Failed to pay creator');
                }
                const cfg = this.getConfirmConfig('capsulePurchase');
                const conf1 = await this.waitForTxConfirmations(toCreatorTx.txId, cfg.target, cfg.timeoutMs);
                txReceipts.push({ txId: toCreatorTx.txId, ...conf1 });
            }
            if (toPlatformTx) {
                const res2 = this.submitTx(toPlatformTx);
                if (this.options.isGenesisNode && !res2.accepted) {
                    throw new Error(res2.reason || 'Failed to pay platform');
                }
                const cfg = this.getConfirmConfig('capsulePurchase');
                const conf2 = await this.waitForTxConfirmations(toPlatformTx.txId, cfg.target, cfg.timeoutMs);
                txReceipts.push({ txId: toPlatformTx.txId, ...conf2 });
            }
            return { capsule, txReceipts };
        }
        return { capsule, txReceipts: [] };
    }
    
    // 提交任务解决方案
    async submitSolution(taskId, solution) {
        const result = await this.taskBazaar.submitSolution(taskId, solution, this.options.nodeId);
        if (result?.winner && this.options.isGenesisNode) {
            const task = this.taskBazaar.getTask(taskId);
            const escrowId = task?.escrowAccountId;
            const bounty = task?.bounty?.amount || 0;
            if (escrowId && bounty > 0) {
                const releaseTx = this.createSignedEscrowRelease(escrowId, result.winnerId, bounty);
                this.submitTx(releaseTx);
            }
        }
        return result;
    }
    
    // 获取网络统计
    getStats() {
        return {
            nodeId: this.options.nodeId,
            peers: this.node.getPeers(),
            memoryCount: this.memoryStore.getCount(),
            taskCount: this.taskBazaar.getTaskCount(),
            uptime: process.uptime()
        };
    }
    
    // 同步网络记忆
    async syncMemories(filter = {}) {
        console.log('🔄 Syncing memories from network...');
        const memories = await this.node.queryMemories(filter);
        for (const capsule of memories) {
            await this.memoryStore.storeCapsule(capsule);
        }
        console.log(`✅ Synced ${memories.length} memories`);
        return memories.length;
    }
    
    computeAssetId(capsule) {
        const crypto = require('crypto');
        const content = JSON.stringify(capsule.content);
        return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
    }
    
    computeTaskId(task) {
        const crypto = require('crypto');
        const content = task.description + task.publisher + task.published_at;
        return 'task_' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
    
    // 关闭
    async stop() {
        console.log('👋 Stopping OpenClaw Mesh...');
        
        if (this.webUI) {
            await this.webUI.stop();
        }
        
        if (this.node) {
            await this.node.stop();
        }
        
        if (this.memoryStore) {
            await this.memoryStore.close();
        }

        if (this.ledger) {
            this.ledger.close();
        }

        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        console.log('✅ OpenClaw Mesh stopped');
    }
}

module.exports = OpenClawMesh;
