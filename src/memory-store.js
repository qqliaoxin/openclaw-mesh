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
        this.initialized = false;
    }
    
    async init() {
        // 确保数据目录存在
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        
        // 加载已有数据
        await this.loadFromDisk();
        
        this.initialized = true;
        console.log(`💾 Memory store initialized: ${this.dataDir}`);
        console.log(`   Loaded ${this.capsules.size} capsules`);
    }
    
    getCapsulesPath() {
        return path.join(this.dataDir, 'capsules.json');
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
    }
    
    async saveToDisk() {
        const filePath = this.getCapsulesPath();
        const data = Object.fromEntries(this.capsules);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
        console.log('💾 Memory store closed');
    }
}

module.exports = MemoryStore;
