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
        this.memoryStore = new MemoryStore(this.options.dataDir);
        await this.memoryStore.init();
        
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
        
        // 添加创建者信息
        capsule.attribution = {
            creator: this.options.nodeId,
            created_at: new Date().toISOString()
        };
        
        // 计算asset_id
        capsule.asset_id = this.computeAssetId(capsule);
        
        // 本地存储
        await this.memoryStore.storeCapsule(capsule);
        
        // 广播到网络
        await this.node.broadcastCapsule(capsule);
        
        console.log(`✅ Capsule published: ${capsule.asset_id}`);
        return capsule.asset_id;
    }
    
    // 发布任务
    async publishTask(task) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        
        task.publisher = this.options.nodeId;
        task.published_at = new Date().toISOString();
        task.taskId = this.computeTaskId(task);
        
        // 存储到本地任务市场
        this.taskBazaar.tasks.set(task.taskId, {
            ...task,
            status: 'open',
            submissions: []
        });
        
        // 广播到网络
        await this.node.broadcastTask(task);
        
        console.log(`🎯 Task published: ${task.taskId}`);
        return task.taskId;
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
        
        console.log('✅ OpenClaw Mesh stopped');
    }
}

module.exports = OpenClawMesh;
