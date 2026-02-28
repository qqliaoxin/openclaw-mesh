/**
 * OpenClaw Mesh - 去中心化技能共享网络
 * Main Entry Point
 */

const MeshNode = require('./node');
const MemoryStore = require('./memory-store');
const TaskBazaar = require('./task-bazaar');
const WebUIServer = require('../web/server');
const TaskWorker = require('./task-worker');
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
            ...options
        };
        
        this.node = null;
        this.memoryStore = null;
        this.taskBazaar = null;
        this.webUI = null;
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
        this.memoryStore.ensureAccount(this.options.nodeId, { algorithm: 'gep-lite-v1' });
        if (!this.options.isGenesisNode && this.options.masterUrl) {
            await this.registerAccountToMaster();
        }
        
        // 初始化P2P节点
        this.node = new MeshNode({
            nodeId: this.options.nodeId,
            port: this.options.port,
            bootstrapNodes: this.options.bootstrapNodes
        });
        await this.node.init();
        
        // 初始化任务市场
        this.taskBazaar = new TaskBazaar({
            nodeId: this.options.nodeId,
            memoryStore: this.memoryStore
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
        if (!this.options.isGenesisNode && this.options.masterUrl) {
            this.syncInterval = setInterval(async () => {
                try {
                    await this.memoryStore.syncFromMaster(this.options.masterUrl);
                    await this.registerAccountToMaster();
                } catch (e) {
                }
            }, 60000);
        }
        
        this.initialized = true;
        console.log(`✅ OpenClaw Mesh initialized successfully!`);
        console.log(`   WebUI: http://localhost:${this.options.webPort}`);
        
        return this;
    }

    async registerAccountToMaster() {
        if (!this.options.masterUrl || this.options.isGenesisNode) return;
        try {
            const payload = this.memoryStore.exportAccount(this.options.nodeId);
            payload.force = true;
            const res = await fetch(`${this.options.masterUrl.replace(/\/$/, '')}/api/account/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => ({}));
            if (data && data.error) {
                console.error(`⚠️  Account sync to master failed: ${data.error}`);
            } else if (!res.ok) {
                console.error(`⚠️  Account sync to master failed: HTTP ${res.status}`);
            } else {
                console.log(`✅ Account synced to master: ${payload.account?.accountId}`);
            }
        } catch (e) {
            console.error(`⚠️  Account sync to master failed: ${e.message}`);
        }
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
        });
        
        // 监听节点断开
        this.node.on('peer:disconnected', (peerId) => {
            console.log(`🔌 Peer disconnected: ${peerId}`);
        });
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

        if (!this.options.isGenesisNode && this.options.masterUrl) {
            const res = await fetch(`${this.options.masterUrl.replace(/\/$/, '')}/api/memory/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: capsule.content,
                    type: capsule.type,
                    tags: capsule.tags || [],
                    price: capsule.price,
                    publisher: this.options.nodeId
                })
            });
            const data = await res.json();
            if (!data.success) {
                throw new Error(data.error || 'Failed to publish capsule');
            }
            if (data.capsule) {
                await this.memoryStore.storeCapsule(data.capsule);
                return data.capsule.asset_id;
            }
            return data.assetId;
        }

        if (this.options.capsulePublishFee > 0) {
            this.memoryStore.debit(this.options.nodeId, this.options.capsulePublishFee, { reason: 'capsule_publish', assetId: capsule.asset_id });
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
        return capsule.asset_id;
    }
    
    // 发布任务
    async publishTask(task) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        
        task.publisher = task.publisher || this.options.nodeId;
        task.published_at = new Date().toISOString();
        task.taskId = this.computeTaskId(task);

        if (!this.options.isGenesisNode && this.options.masterUrl) {
            const res = await fetch(`${this.options.masterUrl.replace(/\/$/, '')}/api/task/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: task.description,
                    bounty: task.bounty?.amount || 0,
                    tags: task.tags || [],
                    publisher: task.publisher
                })
            });
            const data = await res.json();
            if (!data.success) {
                throw new Error(data.error || 'Failed to publish task');
            }
            if (data.task) {
                await this.taskBazaar.handleNewTask(data.task);
                return data.task.taskId;
            }
            return data.taskId || data.task;
        }

        const taskId = await this.taskBazaar.publishTask(task);
        await this.node.broadcastTask(task);
        console.log(`🎯 Task published: ${taskId}`);
        return taskId;
    }

    async purchaseCapsule(assetId, buyerNodeId = null) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        const buyer = buyerNodeId || this.options.nodeId;
        if (!this.options.isGenesisNode && this.options.masterUrl) {
            const res = await fetch(`${this.options.masterUrl.replace(/\/$/, '')}/api/capsule/purchase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assetId, buyerNodeId: buyer })
            });
            const data = await res.json();
            if (!data.success) {
                throw new Error(data.error || 'Failed to purchase capsule');
            }
            if (data.capsule) {
                await this.memoryStore.storeCapsule(data.capsule);
                return data.capsule;
            }
            return null;
        }
        const capsule = this.memoryStore.getCapsule(assetId);
        if (!capsule) {
            throw new Error('Capsule not found');
        }
        const price = capsule.price?.amount || 0;
        if (price > 0 && buyer !== capsule.attribution?.creator) {
            const share = typeof capsule.price?.creatorShare === 'number' ? capsule.price.creatorShare : this.options.capsuleCreatorShare;
            const creatorAmount = Math.floor(price * share);
            const platformAmount = price - creatorAmount;
            this.memoryStore.debit(buyer, price, { reason: 'capsule_purchase', assetId });
            if (creatorAmount > 0) {
                this.memoryStore.credit(capsule.attribution.creator, creatorAmount, { reason: 'capsule_revenue', assetId });
            }
            if (platformAmount > 0) {
                this.memoryStore.credit(this.memoryStore.genesisNodeId, platformAmount, { reason: 'capsule_platform_fee', assetId });
            }
        }
        return capsule;
    }
    
    // 提交任务解决方案
    async submitSolution(taskId, solution) {
        return await this.taskBazaar.submitSolution(taskId, solution, this.options.nodeId);
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

        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        console.log('✅ OpenClaw Mesh stopped');
    }
}

module.exports = OpenClawMesh;
