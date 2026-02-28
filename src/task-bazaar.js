/**
 * TaskBazaar - 任务市场
 * 发布任务、竞标、奖励分配
 */

const EventEmitter = require('events');
const crypto = require('crypto');

class TaskBazaar extends EventEmitter {
    constructor(options = {}) {
        super();
        this.nodeId = options.nodeId;
        this.memoryStore = options.memoryStore;
        this.ledger = options.ledger || null;
        this.walletAccountId = options.walletAccountId || null;
        this.ratingStore = options.ratingStore || null;
        this.dataDir = options.dataDir || process.cwd();
        this.tasksPath = require('path').join(this.dataDir, 'tasks.json');
        
        this.tasks = new Map(); // taskId -> task
        this.submissions = new Map(); // taskId -> [solutions]
        this.completedTasks = new Set();
        this.loadFromDisk();
    }

    loadFromDisk() {
        const fs = require('fs');
        if (!fs.existsSync(this.tasksPath)) return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.tasksPath, 'utf8'));
            if (Array.isArray(raw)) {
                raw.forEach(t => {
                    if (t && t.taskId) {
                        this.tasks.set(t.taskId, t);
                        if (t.status === 'completed') {
                            this.completedTasks.add(t.taskId);
                        }
                    }
                });
            }
        } catch (e) {
        }
    }

    saveToDisk() {
        const fs = require('fs');
        try {
            const payload = Array.from(this.tasks.values());
            fs.writeFileSync(this.tasksPath, JSON.stringify(payload, null, 2));
        } catch (e) {
        }
    }
    
    // 发布任务
    async publishTask(task) {
        // 验证任务
        if (!task.description || !task.bounty) {
            throw new Error('Invalid task: missing description or bounty');
        }
        
        // 生成 taskId
        if (!task.taskId) {
            task.taskId = this.generateTaskId(task);
        }

        task.publisher = task.publisher || this.nodeId;
        task.bounty.token = task.bounty.token || 'CLAW';

        task.escrowAccountId = task.escrowAccountId || this.getEscrowAccountId(task.taskId);
        
        // 存储任务
        task.status = this.isEscrowFunded(task) ? 'open' : 'pending_escrow';
        task.submissions = [];
        this.tasks.set(task.taskId, task);
        this.saveToDisk();
        
        console.log(`🎯 Task published: ${task.taskId}`);
        console.log(`   Bounty: ${task.bounty.amount} ${task.bounty.token}`);
        
        this.emit('task:published', task);
        return task.taskId;
    }
    
    // 处理网络中的新任务
    async handleNewTask(task) {
        if (this.tasks.has(task.taskId)) {
            return; // 已存在
        }
        task.escrowAccountId = task.escrowAccountId || this.getEscrowAccountId(task.taskId);
        task.status = this.isEscrowFunded(task) ? 'open' : 'pending_escrow';
        task.submissions = [];
        this.tasks.set(task.taskId, task);
        this.saveToDisk();
        
        console.log(`📬 New task from network: ${task.taskId}`);
        this.emit('task:received', task);
    }
    
    // 提交解决方案
    async submitSolution(taskId, solution, solverId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error('Task not found');
        }
        
        if (task.status !== 'open') {
            throw new Error('Task is not open');
        }
        
        if (this.completedTasks.has(taskId)) {
            return { success: false, reason: 'Task already completed' };
        }
        
        // 验证解决方案（简化版）
        const valid = await this.validateSolution(task, solution);
        
        if (valid) {
            // 第一个有效解获胜
            this.completedTasks.add(taskId);
            task.status = 'completed';
            task.winner = solverId;
            
            const reward = task.bounty?.amount || 0;
            
            console.log(`🏆 Task completed: ${taskId}`);
            console.log(`   Winner: ${solverId}`);
            console.log(`   Reward: ${reward}`);
            
            this.emit('task:completed', {
                taskId,
                winner: solverId,
                reward
            });
            
            return {
                success: true,
                winner: true,
                reward,
                winnerId: solverId
            };
        }
        
        return {
            success: false,
            reason: 'Invalid solution'
        };
    }
    
    // 验证解决方案
    async validateSolution(task, solution) {
        // 简化验证：检查是否有代码和说明
        if (!solution.code && !solution.description) {
            return false;
        }
        
        // 如果是代码任务，尝试执行验证
        if (task.type === 'code' && solution.code) {
            try {
                // 这里简化处理，实际应该沙箱执行
                return solution.code.length > 10; // 至少10字符
            } catch (e) {
                return false;
            }
        }
        
        return true;
    }
    
    // 获取任务列表
    getTasks(filter = {}) {
        let tasks = Array.from(this.tasks.values());
        
        if (filter.status) {
            tasks = tasks.filter(t => t.status === filter.status);
        }
        
        if (filter.type) {
            tasks = tasks.filter(t => t.type === filter.type);
        }
        
        return tasks.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    }
    
    // 获取单个任务
    getTask(taskId) {
        return this.tasks.get(taskId);
    }
    
    // 获取任务数量
    getTaskCount() {
        return this.tasks.size;
    }
    
    // 更新任务状态
    updateTask(taskId, updates) {
        const task = this.tasks.get(taskId);
        if (task) {
            this.tasks.set(taskId, { ...task, ...updates });
            this.saveToDisk();
            return this.tasks.get(taskId);
        }
        return null;
    }
    
    // 完成任务
    completeTask(taskId, result) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
            task.result = result;
            this.tasks.set(taskId, task);
            this.saveToDisk();
            return task;
        }
        return null;
    }
    
    // 存入积分
    deposit(amount) {
        this.balance += amount;
        return this.balance;
    }
    
    // 获取余额
    getBalance() {
        if (!this.ledger || !this.walletAccountId) {
            return { available: 0, locked: 0 };
        }
        const available = this.ledger.getBalance(this.walletAccountId);
        let locked = 0;
        for (const task of this.tasks.values()) {
            if (task.publisher === this.nodeId && task.escrowAccountId && task.status !== 'completed') {
                locked += this.ledger.getBalance(task.escrowAccountId) || 0;
            }
        }
        return { available, locked };
    }

    isNodeAllowed(nodeId) {
        if (!this.ratingStore || !nodeId) return true;
        return !this.ratingStore.isDisqualified(nodeId);
    }

    isEscrowFunded(task) {
        if (!this.ledger || !task?.escrowAccountId) return true;
        const balance = this.ledger.getBalance(task.escrowAccountId);
        return Number(balance) >= Number(task.bounty?.amount || 0);
    }

    tryActivatePendingTasks() {
        for (const task of this.tasks.values()) {
            if (task.status === 'pending_escrow' && this.isEscrowFunded(task)) {
                task.status = 'open';
                this.tasks.set(task.taskId, task);
            }
        }
    }

    getEscrowAccountId(taskId) {
        const hash = crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 24);
        return `escrow_${hash}`;
    }
    
    // 创建Swarm任务（复杂任务分解）
    async createSwarmTask(description, subtasks, totalBounty) {
        const swarmTask = {
            taskId: this.generateTaskId(),
            type: 'swarm',
            description,
            status: 'open',
            subtasks: subtasks.map((st, i) => ({
                id: `sub_${i}`,
                description: st.description,
                weight: st.weight || 1,
                status: 'open',
                reward: (totalBounty * 0.85) * (st.weight / subtasks.reduce((a, s) => a + s.weight, 0))
            })),
            proposerReward: totalBounty * 0.05,
            aggregatorReward: totalBounty * 0.10,
            bounty: {
                amount: totalBounty,
                token: 'CLAW'
            },
            published_at: new Date().toISOString()
        };
        
        return await this.publishTask(swarmTask);
    }
    
    generateTaskId() {
        return 'task_' + crypto.randomBytes(8).toString('hex');
    }
    
    // 获取统计
    getStats() {
        const tasks = Array.from(this.tasks.values());
        return {
            total: tasks.length,
            open: tasks.filter(t => t.status === 'open').length,
            completed: tasks.filter(t => t.status === 'completed').length,
            totalRewards: tasks
                .filter(t => t.status === 'completed')
                .reduce((sum, t) => sum + (t.bounty?.amount || 0), 0)
        };
    }
}

module.exports = TaskBazaar;
