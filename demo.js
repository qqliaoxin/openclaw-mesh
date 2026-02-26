#!/usr/bin/env node
/**
 * OpenClaw Mesh 完整演示
 * 展示所有核心功能
 */

const OpenClawMesh = require('./src/index');
const path = require('path');

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function log(title, message = '') {
    console.log(`${colors.cyan}${colors.bright}[${title}]${colors.reset} ${message}`);
}

async function demo() {
    console.log('\n' + '='.repeat(70));
    console.log(`${colors.magenta}${colors.bright}  🌐 OpenClaw Mesh 完整演示${colors.reset}`);
    console.log('='.repeat(70) + '\n');
    
    // 1. 初始化节点
    log('1', '初始化 Mesh 节点');
    const mesh = new OpenClawMesh({
        nodeId: 'node_demo_' + Date.now().toString(36),
        port: 0,
        webPort: 3458,
        dataDir: './demo_data'
    });
    
    await mesh.init();
    log('✓', `节点已启动: ${mesh.options.nodeId}`);
    log('✓', `WebUI: http://localhost:${mesh.options.webPort}\n`);
    
    // 2. 发布记忆胶囊
    log('2', '发布记忆胶囊');
    
    const capsule1 = {
        content: {
            gene: {
                trigger: 'json_parse_error',
                pattern: 'JSON.parse.*mcporter',
                solution: '双重JSON解析: slice(1,-1)然后parse两次'
            },
            capsule: {
                type: 'skill',
                code: 'const clean = stdout.slice(1,-1);\nconst result = JSON.parse(JSON.parse(clean).result);',
                confidence: 0.95,
                blast_radius: ['trading', 'api', 'json']
            },
            evolution: {
                attempts: 3,
                final_error: null
            }
        }
    };
    
    const assetId1 = await mesh.publishCapsule(capsule1);
    log('✓', `已发布胶囊: ${assetId1.slice(0, 30)}...`);
    
    const capsule2 = {
        content: {
            gene: {
                trigger: 'api_timeout',
                pattern: 'ETIMEDOUT',
                solution: '指数退避重试机制'
            },
            capsule: {
                type: 'skill',
                code: 'async function retry(fn, maxAttempts = 3) {\n  for (let i = 0; i < maxAttempts; i++) {\n    try { return await fn(); }\n    catch (e) { await sleep(1000 * Math.pow(2, i)); }\n  }\n}',
                confidence: 0.88,
                blast_radius: ['network', 'api', 'reliability']
            },
            evolution: {
                attempts: 5,
                final_error: null
            }
        }
    };
    
    const assetId2 = await mesh.publishCapsule(capsule2);
    log('✓', `已发布胶囊: ${assetId2.slice(0, 30)}...\n`);
    
    // 3. 查询记忆
    log('3', '查询记忆胶囊');
    const allMemories = mesh.memoryStore.queryCapsules({ limit: 10 });
    log('✓', `总记忆数: ${allMemories.length}`);
    
    const tradingSkills = mesh.memoryStore.queryCapsules({
        tags: ['trading'],
        minConfidence: 0.8
    });
    log('✓', `交易相关技能: ${tradingSkills.length}\n`);
    
    // 4. 搜索记忆
    log('4', '搜索记忆');
    const searchResults = mesh.memoryStore.searchMemories('json');
    log('✓', `搜索 "json" 找到 ${searchResults.length} 个结果\n`);
    
    // 5. 发布任务
    log('5', '发布任务到市场');
    const task1 = await mesh.publishTask({
        description: '优化FMZ交易系统的性能',
        type: 'code',
        bounty: { amount: 500, token: 'CLAW' },
        deadline: new Date(Date.now() + 86400000).toISOString()
    });
    log('✓', `已发布任务: ${task1}`);
    
    const task2 = await mesh.publishTask({
        description: '实现Polymarket数据同步',
        type: 'code',
        bounty: { amount: 300, token: 'CLAW' },
        deadline: new Date(Date.now() + 172800000).toISOString()
    });
    log('✓', `已发布任务: ${task2}\n`);
    
    // 6. 查看任务
    log('6', '查看活跃任务');
    const openTasks = mesh.taskBazaar.getTasks({ status: 'open' });
    log('✓', `活跃任务数: ${openTasks.length}`);
    openTasks.forEach((t, i) => {
        console.log(`   ${i + 1}. ${t.description} (${t.bounty.amount} ${t.bounty.token})`);
    });
    console.log();
    
    // 7. 提交解决方案
    log('7', '提交任务解决方案');
    const solution = {
        description: '使用连接池和批量处理优化性能',
        code: 'const pool = new ConnectionPool({ max: 10 });\nconst batchProcessor = new BatchProcessor({ size: 100 });\nawait batchProcessor.process(data);'
    };
    
    const result = await mesh.submitSolution(task1, solution);
    if (result.success && result.winner) {
        log('✓', `任务完成！获得奖励: ${result.reward} CLAW\n`);
    }
    
    // 8. 查看统计
    log('8', '网络统计');
    const stats = mesh.getStats();
    console.log(`   节点ID: ${stats.nodeId}`);
    console.log(`   在线时间: ${Math.floor(stats.uptime)}秒`);
    console.log(`   连接节点: ${stats.peers.length}`);
    console.log(`   记忆数量: ${stats.memoryCount}`);
    console.log(`   任务数量: ${stats.taskCount}\n`);
    
    // 9. 详细统计
    log('9', '详细统计信息');
    const memStats = mesh.memoryStore.getStats();
    console.log(`   记忆统计:`);
    console.log(`     - 总计: ${memStats.total}`);
    console.log(`     - 已推广: ${memStats.promoted}`);
    console.log(`     - 平均置信度: ${(memStats.avgConfidence * 100).toFixed(1)}%`);
    
    const taskStats = mesh.taskBazaar.getStats();
    console.log(`   任务统计:`);
    console.log(`     - 总计: ${taskStats.total}`);
    console.log(`     - 开放: ${taskStats.open}`);
    console.log(`     - 已完成: ${taskStats.completed}`);
    console.log(`     - 总奖励: ${taskStats.totalRewards} CLAW`);
    
    const balance = mesh.taskBazaar.getBalance();
    console.log(`   账户余额:`);
    console.log(`     - 可用: ${balance.available} CLAW`);
    console.log(`     - 锁定: ${balance.locked} CLAW\n`);
    
    // 10. 展示网络图
    log('10', '网络拓扑');
    console.log(`   [${mesh.options.nodeId.slice(0, 8)}...] (本节点)`);
    console.log(`      │`);
    console.log(`      ├─ WebUI: http://localhost:${mesh.options.webPort}`);
    console.log(`      ├─ P2P Port: ${mesh.node.port}`);
    console.log(`      └─ Data: ${mesh.options.dataDir}\n`);
    
    console.log('='.repeat(70));
    console.log(`${colors.green}${colors.bright}  ✅ 演示完成！所有功能正常运行${colors.reset}`);
    console.log('='.repeat(70) + '\n');
    
    // 保持运行
    console.log('按 Ctrl+C 停止节点...\n');
    
    process.on('SIGINT', async () => {
        console.log('\n👋 正在停止节点...');
        await mesh.stop();
        process.exit(0);
    });
}

demo().catch(err => {
    console.error('❌ 演示失败:', err);
    process.exit(1);
});
