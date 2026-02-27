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
        
        this.tasks = new Map(); // taskId -> task
        this.submissions = new Map(); // taskId -> [solutions]
        this.completedTasks = new Set();
        
        this.balance = 1000; // 初始积分
        this.escrow = new Map(); // taskId -> locked amount
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

        if (this.memoryStore && typeof this.memoryStore.lockEscrow === 'function') {
            this.memoryStore.lockEscrow(task.taskId, task.publisher, task.bounty.amount, task.bounty.token);
        } else {
            if (this.balance < task.bounty.amount) {
                throw new Error('Insufficient balance');
            }
            this.balance -= task.bounty.amount;
            this.escrow.set(task.taskId, task.bounty.amount);
        }
        
        // 存储任务
        task.status = 'open';
        task.submissions = [];
        this.tasks.set(task.taskId, task);
        
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
        
        task.status = 'open';
        task.submissions = [];
        this.tasks.set(task.taskId, task);
        
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
            
            // 发放奖励
            let reward = 0;
            if (this.memoryStore && typeof this.memoryStore.releaseEscrow === 'function') {
                const released = this.memoryStore.releaseEscrow(taskId, solverId);
                reward = released.released || 0;
            } else {
                reward = this.escrow.get(taskId) || 0;
                this.escrow.delete(taskId);
            }
            
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
                reward
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
        if (this.memoryStore && typeof this.memoryStore.getBalance === 'function') {
            const locked = Array.from(this.memoryStore.escrows?.values?.() || [])
                .filter(e => e.from === this.nodeId)
                .reduce((a, b) => a + (b.amount || 0), 0);
            return {
                available: this.memoryStore.getBalance(this.nodeId),
                locked
            };
        }
        return {
            available: this.balance,
            locked: Array.from(this.escrow.values()).reduce((a, b) => a + b, 0)
        };
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
