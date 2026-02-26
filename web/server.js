/**
 * WebUIServer - Web管理界面
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

class WebUIServer {
    constructor(options = {}) {
        this.port = options.port || 3457;
        this.mesh = options.mesh;
        this.server = null;
        this.wss = null;
    }
    
    async start() {
        // 创建HTTP服务器
        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });
        
        // 创建WebSocket服务器
        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (ws) => {
            this.handleWebSocket(ws);
        });
        
        // 启动服务器
        return new Promise((resolve) => {
            this.server.listen(this.port, () => {
                console.log(`🌐 WebUI server started on port ${this.port}`);
                resolve();
            });
        });
    }
    
    handleRequest(req, res) {
        const url = req.url;
        
        // API路由
        if (url.startsWith('/api/')) {
            this.handleAPI(req, res);
            return;
        }
        
        // 静态文件
        if (url === '/' || url === '/index.html') {
            this.serveHTML(res);
            return;
        }
        
        // 404
        res.writeHead(404);
        res.end('Not Found');
    }
    
    handleAPI(req, res) {
        const url = req.url;
        
        // 设置CORS
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        let data = {};
        
        if (url === '/api/status') {
            data = this.mesh ? this.mesh.getStats() : { error: 'Mesh not initialized' };
        } else if (url === '/api/memories') {
            data = this.mesh ? this.mesh.memoryStore.queryCapsules({ limit: 50 }) : [];
        } else if (url === '/api/tasks') {
            data = this.mesh ? this.mesh.taskBazaar.getTasks() : [];
        } else if (url === '/api/peers') {
            data = this.mesh ? this.mesh.node.getPeers() : [];
        } else if (url.startsWith('/api/memory/')) {
            const assetId = url.split('/').pop();
            data = this.mesh ? this.mesh.memoryStore.getCapsule(assetId) : null;
        } else if (url === '/api/stats') {
            data = {
                memories: this.mesh ? this.mesh.memoryStore.getStats() : {},
                tasks: this.mesh ? this.mesh.taskBazaar.getStats() : {},
                balance: this.mesh ? this.mesh.taskBazaar.getBalance() : {}
            };
        } else if (url.startsWith('/api/tasks/') && url.endsWith('/download')) {
            // Handle task package download
            const parts = url.split('/');
            const taskId = parts[3];
            
            try {
                const fs = require('fs');
                const completedBasePath = path.join(path.resolve(__dirname, '..'), 'task-workspace', 'completed');
                
                // Search for the task in all node directories
                let zipPath = null;
                
                if (fs.existsSync(completedBasePath)) {
                    const nodeDirs = fs.readdirSync(completedBasePath);
                    for (const nodeDir of nodeDirs) {
                        // Check if this directory contains our taskId
                        if (nodeDir.includes(taskId)) {
                            const potentialZip = require('path').join(completedBasePath, nodeDir, `${taskId}.zip`);
                            if (fs.existsSync(potentialZip)) {
                                zipPath = potentialZip;
                                break;
                            }
                        }
                    }
                }
                
                if (zipPath) {
                    res.setHeader('Content-Type', 'application/zip');
                    res.setHeader('Content-Disposition', `attachment; filename="${taskId}.zip"`);
                    fs.createReadStream(zipPath).pipe(res);
                    return;
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Package not found', taskId }));
                    return;
                }
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
                return;
            }
        } else if (url === '/api/task/publish' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    if (this.mesh) {
                        const task = await this.mesh.publishTask({
                            description: payload.description,
                            bounty: { amount: payload.bounty || 100, token: 'CLAW' },
                            tags: payload.tags || []
                        });
                        data = { success: true, task };
                    } else {
                        data = { error: 'Mesh not initialized' };
                    }
                } catch (e) {
                    data = { error: e.message };
                }
            });
            return;
        } else if (url === '/api/memory/publish' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    if (this.mesh) {
                        const capsule = await this.mesh.publishCapsule({
                            content: payload.content,
                            type: payload.type || 'repair',
                            tags: payload.tags || []
                        });
                        data = { success: true, capsule };
                    } else {
                        data = { error: 'Mesh not initialized' };
                    }
                } catch (e) {
                    data = { error: e.message };
                }
            });
            return;
        }
        
        res.writeHead(200);
        res.end(JSON.stringify(data));
    }
    
    handleWebSocket(ws) {
        console.log('🔌 WebSocket client connected');
        
        // 发送初始数据
        if (this.mesh) {
            ws.send(JSON.stringify({
                type: 'status',
                data: this.mesh.getStats()
            }));
        }
        
        // 定期更新
        const interval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN && this.mesh) {
                ws.send(JSON.stringify({
                    type: 'status',
                    data: this.mesh.getStats()
                }));
            }
        }, 5000);
        
        ws.on('close', () => {
            clearInterval(interval);
            console.log('🔌 WebSocket client disconnected');
        });
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                this.handleWebSocketMessage(ws, data);
            } catch (e) {
                console.error('Invalid WebSocket message:', e);
            }
        });
    }
    
    handleWebSocketMessage(ws, data) {
        switch (data.type) {
            case 'publish':
                // 处理发布请求
                break;
            case 'search':
                // 处理搜索请求
                break;
        }
    }
    
    serveHTML(res) {
        const html = this.generateHTML();
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(html);
    }
    
    generateHTML() {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenClaw Mesh Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f1419;
            color: #e6e6e6;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        
        header {
            background: linear-gradient(135deg, #1a2332 0%, #2d3748 100%);
            padding: 30px;
            border-radius: 16px;
            margin-bottom: 30px;
        }
        
        header h1 {
            font-size: 32px;
            background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: #1a2332;
            padding: 25px;
            border-radius: 12px;
            border: 1px solid #2d3748;
        }
        
        .stat-card h3 {
            color: #8892a0;
            font-size: 14px;
            text-transform: uppercase;
        }
        
        .stat-value {
            font-size: 36px;
            font-weight: bold;
            margin-top: 10px;
        }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
            background: #1a2332;
            padding: 10px;
            border-radius: 12px;
        }
        
        .tab {
            padding: 12px 24px;
            background: transparent;
            border: none;
            color: #8892a0;
            cursor: pointer;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
        }
        
        .tab.active {
            background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%);
            color: #fff;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .card {
            background: #1a2332;
            border-radius: 16px;
            padding: 30px;
            margin-bottom: 30px;
        }
        
        .card h2 {
            font-size: 20px;
            margin-bottom: 20px;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 8px;
            color: #8892a0;
            font-size: 14px;
        }
        
        .form-group input,
        .form-group textarea,
        .form-group select {
            width: 100%;
            padding: 12px 16px;
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 8px;
            color: #fff;
            font-size: 14px;
        }
        
        .form-group input:focus,
        .form-group textarea:focus,
        .form-group select:focus {
            outline: none;
            border-color: #00d4ff;
        }
        
        .btn {
            padding: 12px 24px;
            background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%);
            border: none;
            border-radius: 8px;
            color: #fff;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
        }
        
        .btn:hover {
            opacity: 0.9;
        }
        
        .btn-small {
            padding: 4px 10px;
            background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%);
            border: none;
            border-radius: 4px;
            color: #fff;
            font-size: 11px;
            cursor: pointer;
            margin-left: 8px;
        }
        
        .btn-small:hover {
            opacity: 0.85;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th, td {
            text-align: left;
            padding: 15px;
            border-bottom: 1px solid #2d3748;
        }
        
        th {
            color: #8892a0;
            font-size: 12px;
            text-transform: uppercase;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
        }
        
        .badge-success {
            background: rgba(0, 212, 170, 0.2);
            color: #00d4aa;
        }
        
        .badge-pending {
            background: rgba(245, 158, 11, 0.2);
            color: #f59e0b;
        }
        
        .network-graph {
            height: 350px;
            background: linear-gradient(135deg, #0f1419 0%, #1a1f2e 100%);
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }
        
        .network-graph::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background-image: 
                radial-gradient(circle at 20% 30%, rgba(0, 212, 255, 0.05) 0%, transparent 50%),
                radial-gradient(circle at 80% 70%, rgba(124, 58, 237, 0.05) 0%, transparent 50%);
            pointer-events: none;
        }
        
        .node {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            background: linear-gradient(135deg, #1e3a5f 0%, #2d1b4e 100%);
            border: 2px solid #00d4ff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
            font-size: 11px;
            position: absolute;
            color: #00d4ff;
            box-shadow: 
                0 0 20px rgba(0, 212, 255, 0.3),
                inset 0 0 20px rgba(0, 212, 255, 0.1);
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 5;
        }
        
        .node:hover {
            transform: scale(1.15);
            box-shadow: 
                0 0 30px rgba(0, 212, 255, 0.5),
                inset 0 0 25px rgba(0, 212, 255, 0.2);
        }
        
        .node.center {
            width: 90px;
            height: 90px;
            background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%);
            border: none;
            color: #fff;
            font-size: 14px;
            font-weight: 700;
            z-index: 10;
            box-shadow: 
                0 0 40px rgba(0, 212, 255, 0.5),
                0 0 80px rgba(124, 58, 237, 0.3);
        }
        
        .node.center::after {
            content: '★';
            position: absolute;
            top: -8px;
            right: -8px;
            font-size: 16px;
        }
        
        .connection {
            position: absolute;
            height: 2px;
            background: linear-gradient(90deg, rgba(0, 212, 255, 0.6), rgba(124, 58, 237, 0.6));
            transform-origin: left center;
            z-index: 1;
            animation: pulseLine 2s ease-in-out infinite;
        }
        
        @keyframes pulseLine {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 0.8; }
        }
        
        .data-packet {
            position: absolute;
            width: 8px;
            height: 8px;
            background: #00d4ff;
            border-radius: 50%;
            box-shadow: 0 0 10px #00d4ff;
            z-index: 2;
            animation: packetMove 1.5s ease-in-out infinite;
        }
        
        @keyframes packetMove {
            0% { opacity: 0; transform: scale(0.5); }
            50% { opacity: 1; transform: scale(1); }
            100% { opacity: 0; transform: scale(0.5); }
        }
        
        .node-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .node-item {
            display: flex;
            align-items: center;
            gap: 16px;
            padding: 16px 20px;
            background: linear-gradient(135deg, #1a2332 0%, #12192a 100%);
            border-radius: 12px;
            border: 1px solid #2d3748;
            transition: all 0.3s ease;
        }
        
        .node-item:hover {
            border-color: #00d4ff;
            box-shadow: 0 4px 20px rgba(0, 212, 255, 0.15);
        }
        
        .node-item.current {
            background: linear-gradient(135deg, #1e3a5f 0%, #2d1b4e 100%);
            border-color: #00d4ff;
        }
        
        .node-icon {
            width: 44px;
            height: 44px;
            border-radius: 50%;
            background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
        }
        
        .node-item.current .node-icon {
            box-shadow: 0 0 20px rgba(0, 212, 255, 0.5);
        }
        
        .node-info {
            flex: 1;
        }
        
        .node-label {
            font-size: 12px;
            color: #8892a0;
            margin-bottom: 4px;
        }
        
        .node-id {
            font-size: 14px;
            font-family: monospace;
            color: #fff;
        }
        
        .node-ip {
            font-size: 12px;
            color: #8892a0;
            font-family: monospace;
        }
        
        .node-status {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
        }
        
        .node-status.online {
            background: rgba(0, 212, 170, 0.15);
            color: #00d4aa;
        }
        
        .node-status.offline {
            background: rgba(239, 68, 68, 0.15);
            color: #ef4444;
        }
        
        h3 {
            color: #8892a0;
            font-size: 14px;
            font-weight: 500;
            text-transform: uppercase;
            margin-bottom: 12px;
        }
        
        .refresh-btn {
            position: fixed;
            bottom: 30px;
            right: 30px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%);
            border: none;
            color: #fff;
            font-size: 24px;
            cursor: pointer;
        }
        
        .lang-btn {
            padding: 8px 16px;
            background: rgba(255,255,255,0.1);
            border: 1px solid #30363d;
            border-radius: 8px;
            color: #fff;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s;
        }
        
        .lang-btn:hover {
            background: rgba(0, 212, 255, 0.2);
            border-color: #00d4ff;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <h1>🌐 OpenClaw Mesh Dashboard</h1>
                    <p>Decentralized Skill Sharing Network</p>
                </div>
                <button class="lang-btn" onclick="toggleLang()">🇨🇳 中文</button>
            </div>
        </header>
        
        <script>
            const lang = {
                en: {
                    nodeId: 'Node ID', peers: 'Peers', memories: 'Memories', tasks: 'Tasks', uptime: 'Uptime',
                    network: 'Network', memoriesTab: 'Memories', tasksTab: 'Tasks', publish: 'Publish', stats: 'Stats',
                    networkTopology: 'Network Topology', currentNode: 'Current Node', connectedPeers: 'Connected Peers', online: 'Online', offline: 'Offline', ip: 'IP Address', recentMemories: 'Recent Memories', activeTasks: 'Active Tasks',
                    assetId: 'Asset ID', type: 'Type', confidence: 'Confidence', creator: 'Creator',
                    taskId: 'Task ID', description: 'Description', bounty: 'Bounty', status: 'Status',
                    detailedStats: 'Detailed Statistics', memoryStats: 'Memory Statistics', total: 'Total',
                    promoted: 'Promoted', avgConfidence: 'Avg Confidence', taskStats: 'Task Statistics',
                    open: 'Open', completed: 'Completed', totalRewards: 'Total Rewards', balance: 'Balance',
                    available: 'Available', locked: 'Locked', publishTask: 'Publish Task', publishCapsule: 'Publish Memory Capsule',
                    descLabel: 'Description:', bountyLabel: 'Bounty (CLAW):', tagsLabel: 'Tags (comma separated):',
                    contentLabel: 'Content:', typeLabel: 'Type:', taskSuccess: '✅ Task published successfully!',
                    capsuleSuccess: '✅ Capsule published successfully!', download: 'Download',
                    repair: 'Repair', optimize: 'Optimize', innovate: 'Innovate', working: 'Working'
                },
                zh: {
                    nodeId: '节点ID', peers: '节点', memories: '记忆', tasks: '任务', uptime: '运行时间',
                    network: '网络', memoriesTab: '记忆', tasksTab: '任务', publish: '发布', stats: '统计',
                    networkTopology: '网络拓扑', currentNode: '当前节点', connectedPeers: '已连接节点', online: '在线', offline: '离线', ip: 'IP地址', recentMemories: '最近记忆', activeTasks: '活跃任务',
                    assetId: '资产ID', type: '类型', confidence: '置信度', creator: '创建者',
                    taskId: '任务ID', description: '描述', bounty: '赏金', status: '状态',
                    detailedStats: '详细统计', memoryStats: '记忆统计', total: '总计',
                    promoted: '已推广', avgConfidence: '平均置信度', taskStats: '任务统计',
                    open: '开放', completed: '已完成', totalRewards: '总奖励', balance: '余额',
                    available: '可用', locked: '锁定', publishTask: '发布任务', publishCapsule: '发布记忆胶囊',
                    descLabel: '描述：', bountyLabel: '赏金 (CLAW)：', tagsLabel: '标签（逗号分隔）：',
                    contentLabel: '内容：', typeLabel: '类型：', taskSuccess: '✅ 任务发布成功！',
                    capsuleSuccess: '✅ 胶囊发布成功！', download: '下载',
                    repair: '修复', optimize: '优化', innovate: '创新', working: '处理中'
                }
            };
            let currentLang = 'en';
            let t = (key) => lang[currentLang][key] || key;
            
            function toggleLang() {
                currentLang = currentLang === 'en' ? 'zh' : 'en';
                document.querySelector('.lang-btn').textContent = currentLang === 'en' ? '🇨🇳 中文' : '🇺🇸 English';
                updateLabels();
                refreshData();
            }
            
            function updateLabels() {
                document.querySelectorAll('[data-i18n]').forEach(el => {
                    const key = el.getAttribute('data-i18n');
                    if (lang[currentLang][key]) {
                        el.textContent = lang[currentLang][key];
                    }
                });
            }
        </script>
        
        <div class="stats-grid">
            <div class="stat-card">
                <h3 data-i18n="nodeId">Node ID</h3>
                <div class="stat-value" style="font-size: 14px;" id="nodeId">-</div>
            </div>
            <div class="stat-card">
                <h3 data-i18n="peers">Peers</h3>
                <div class="stat-value" id="peerCount">0</div>
            </div>
            <div class="stat-card">
                <h3 data-i18n="memories">Memories</h3>
                <div class="stat-value" id="memoryCount">0</div>
            </div>
            <div class="stat-card">
                <h3 data-i18n="tasks">Tasks</h3>
                <div class="stat-value" id="taskCount">0</div>
            </div>
        </div>
        
        <div class="tabs">
            <button class="tab active" onclick="switchTab('network')" data-i18n="network">Network</button>
            <button class="tab" onclick="switchTab('memories')" data-i18n="memoriesTab">Memories</button>
            <button class="tab" onclick="switchTab('tasks')" data-i18n="tasksTab">Tasks</button>
            <button class="tab" onclick="switchTab('publish')" data-i18n="publish">Publish</button>
            <button class="tab" onclick="switchTab('stats')" data-i18n="stats">Stats</button>
        </div>
        
        <div id="network" class="tab-content active">
            <div class="card">
                <h2 data-i18n="networkTopology">Network Topology</h2>
                <div class="node-list" id="nodeList">
                    <!-- My Node -->
                    <div class="node-item current">
                        <div class="node-icon">⭐</div>
                        <div class="node-info">
                            <div class="node-label" data-i18n="currentNode">Current Node</div>
                            <div class="node-id" id="myNodeId">-</div>
                        </div>
                        <div class="node-status online">● <span data-i18n="online">Online</span></div>
                    </div>
                </div>
                <h3 data-i18n="connectedPeers" style="margin-top:20px;">Connected Peers</h3>
                <div class="node-list" id="peerList"></div>
            </div>
        </div>
        
        <div id="memories" class="tab-content">
            <div class="card">
                <h2 data-i18n="recentMemories">Recent Memories</h2>
                <table id="memoriesTable">
                    <thead>
                        <tr>
                            <th data-i18n="assetId">Asset ID</th>
                            <th data-i18n="type">Type</th>
                            <th data-i18n="confidence">Confidence</th>
                            <th data-i18n="creator">Creator</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>
        
        <div id="tasks" class="tab-content">
            <div class="card">
                <h2 data-i18n="activeTasks">Active Tasks</h2>
                <table id="tasksTable">
                    <thead>
                        <tr>
                            <th data-i18n="taskId">Task ID</th>
                            <th data-i18n="description">Description</th>
                            <th data-i18n="bounty">Bounty</th>
                            <th data-i18n="status">Status</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>
        
        <div id="publish" class="tab-content">
            <div class="card">
                <h2 data-i18n="publishTask">Publish Task</h2>
                <form id="taskForm" onsubmit="publishTask(event)">
                    <div class="form-group">
                        <label>Description:</label>
                        <textarea id="taskDesc" rows="3" required placeholder="Describe the task..."></textarea>
                    </div>
                    <div class="form-group">
                        <label>Bounty (CLAW):</label>
                        <input type="number" id="taskBounty" min="1" value="100" required>
                    </div>
                    <div class="form-group">
                        <label>Tags (comma separated):</label>
                        <input type="text" id="taskTags" placeholder="trading, api, optimization">
                    </div>
                    <button type="submit" class="btn" data-i18n="publishTask">Publish Task</button>
                </form>
                <div id="publishResult" style="margin-top: 10px;"></div>
            </div>
            
            <div class="card" style="margin-top: 20px;">
                <h2 data-i18n="publishCapsule">Publish Memory Capsule</h2>
                <form id="capsuleForm" onsubmit="publishCapsule(event)">
                    <div class="form-group">
                        <label>Content:</label>
                        <textarea id="capsuleContent" rows="4" required placeholder="Solution or knowledge..."></textarea>
                    </div>
                    <div class="form-group">
                        <label>Type:</label>
                        <select id="capsuleType">
                            <option value="repair">Repair</option>
                            <option value="optimize">Optimize</option>
                            <option value="innovate">Innovate</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Tags:</label>
                        <input type="text" id="capsuleTags" placeholder="javascript, error-handling">
                    </div>
                    <button type="submit" class="btn">Publish Capsule</button>
                </form>
                <div id="capsuleResult" style="margin-top: 10px;"></div>
            </div>
        </div>
        
        <div id="stats" class="tab-content">
            <div class="card">
                <h2 data-i18n="detailedStats">Detailed Statistics</h2>
                <div id="detailedStats"></div>
            </div>
        </div>
    </div>
    
    <button class="refresh-btn" onclick="refreshData()">↻</button>
    
    <script>
        let ws;
        
        function connectWebSocket() {
            ws = new WebSocket('ws://localhost:${this.port}');
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'status') {
                    updateUI(data.data);
                }
            };
            
            ws.onclose = () => {
                setTimeout(connectWebSocket, 3000);
            };
        }
        
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName).classList.add('active');
        }
        
        async function refreshData() {
            try {
                const status = await fetch('/api/status').then(r => r.json());
                updateUI(status);
                
                const memories = await fetch('/api/memories').then(r => r.json());
                updateMemories(memories);
                
                const tasks = await fetch('/api/tasks').then(r => r.json());
                updateTasks(tasks);
                
                const stats = await fetch('/api/stats').then(r => r.json());
                updateStats(stats);
            } catch (e) {
                console.error('Failed to refresh:', e);
            }
        }
        
        function updateUI(data) {
            document.getElementById('nodeId').textContent = data.nodeId ? data.nodeId.slice(0, 16) + '...' : '-';
            document.getElementById('myNodeId').textContent = data.nodeId || '-';
            document.getElementById('peerCount').textContent = data.peers ? data.peers.length : 0;
            document.getElementById('memoryCount').textContent = data.memoryCount || 0;
            document.getElementById('taskCount').textContent = data.taskCount || 0;
            
            updateNodeList(data.nodeId, data.peers || []);
        }
        
        function updateNodeList(nodeId, peers) {
            const peerList = document.getElementById('peerList');
            peerList.innerHTML = peers.map((peer, i) => \`
                <div class="node-item">
                    <div class="node-icon">🔗</div>
                    <div class="node-info">
                        <div class="node-label">\${t('nodeId')}</div>
                        <div class="node-id">\${peer.nodeId || peer}</div>
                        <div class="node-ip">\${peer.ip || 'P2P Connection'}</div>
                    </div>
                    <div class="node-status online">● \${t('online')}</div>
                </div>
            \`).join('');
            
            if (peers.length === 0) {
                peerList.innerHTML = '<p style="color:#8892a0;text-align:center;padding:20px;">' + 
                    (currentLang === 'zh' ? '暂无连接的节点' : 'No connected peers') + '</p>';
            }
        }
        
        function updateMemories(memories) {
            const tbody = document.querySelector('#memoriesTable tbody');
            tbody.innerHTML = memories.slice(0, 10).map(m => \`
                <tr>
                    <td>\${m.asset_id.slice(0, 20)}...</td>
                    <td>\${m.type}</td>
                    <td>\${(m.confidence * 100).toFixed(0)}%</td>
                    <td>\${m.attribution.creator.slice(0, 10)}...</td>
                </tr>
            \`).join('');
        }
        
        function updateTasks(tasks) {
            const tbody = document.querySelector('#tasksTable tbody');
            tbody.innerHTML = tasks.slice(0, 10).map(t => \`
                <tr>
                    <td style="font-family:monospace;font-size:12px;">\${t.taskId.slice(0, 20)}...</td>
                    <td>\${t.description.slice(0, 40)}\${t.description.length > 40 ? '...' : ''}</td>
                    <td>\${t.bounty?.amount || 0} \${t.bounty?.token || 'CLAW'}</td>
                    <td>
                        <span class="badge badge-\${t.status === 'completed' ? 'success' : (t.status === 'working' ? 'info' : 'pending')}">
                            \${t.status === 'completed' ? (currentLang === 'zh' ? '已完成' : t.status) : 
                              t.status === 'working' ? (currentLang === 'zh' ? '处理中' : t.status) : 
                              (currentLang === 'zh' ? '开放' : t.status)}
                        </span>
                        \${t.status === 'completed' ? \`<button class="btn-small" onclick="downloadTask('\${t.taskId}')">⬇ \${currentLang === 'zh' ? '下载' : 'Download'}</button>\` : ''}
                    </td>
                </tr>
            \`).join('');
        }
        
        function downloadTask(taskId) {
            window.location.href = '/api/tasks/' + taskId + '/download';
        }
        
        async function publishTask(e) {
            e.preventDefault();
            const desc = document.getElementById('taskDesc').value;
            const bounty = parseInt(document.getElementById('taskBounty').value);
            const tags = document.getElementById('taskTags').value.split(',').map(t => t.trim()).filter(t => t);
            
            try {
                const res = await fetch('/api/task/publish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ description: desc, bounty, tags })
                });
                const data = await res.json();
                const successMessage = currentLang === 'zh'
                    ? '✅ 任务已发布：' + (data.task || '')
                    : '✅ Task published: ' + (data.task || '');
                document.getElementById('publishResult').innerHTML = data.success 
                    ? '<span style="color:green">' + successMessage + '</span>'
                    : '<span style="color:red">❌ ' + (data.error || 'Failed') + '</span>';
                if (data.success) {
                    document.getElementById('taskForm').reset();
                    refreshData();
                }
            } catch (e) {
                document.getElementById('publishResult').innerHTML = '<span style="color:red">❌ Error: ' + e.message + '</span>';
            }
        }
        
        async function publishCapsule(e) {
            e.preventDefault();
            const content = document.getElementById('capsuleContent').value;
            const type = document.getElementById('capsuleType').value;
            const tags = document.getElementById('capsuleTags').value.split(',').map(t => t.trim()).filter(t => t);
            
            try {
                const res = await fetch('/api/memory/publish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, type, tags })
                });
                const data = await res.json();
                document.getElementById('capsuleResult').innerHTML = data.success 
                    ? '<span style="color:green">✅ Capsule published successfully!</span>'
                    : '<span style="color:red">❌ ' + (data.error || 'Failed') + '</span>';
                if (data.success) {
                    document.getElementById('capsuleForm').reset();
                    refreshData();
                }
            } catch (e) {
                document.getElementById('capsuleResult').innerHTML = '<span style="color:red">❌ Error: ' + e.message + '</span>';
            }
        }
        
        function updateStats(stats) {
            document.getElementById('detailedStats').innerHTML = \`
                <h3>Memory Statistics</h3>
                <p>Total: \${stats.memories.total || 0}</p>
                <p>Promoted: \${stats.memories.promoted || 0}</p>
                <p>Avg Confidence: \${(stats.memories.avgConfidence * 100).toFixed(1)}%</p>
                <br>
                <h3>Task Statistics</h3>
                <p>Total: \${stats.tasks.total || 0}</p>
                <p>Open: \${stats.tasks.open || 0}</p>
                <p>Completed: \${stats.tasks.completed || 0}</p>
                <p>Total Rewards: \${stats.tasks.totalRewards || 0}</p>
                <br>
                <h3>Balance</h3>
                <p>Available: \${stats.balance.available || 0}</p>
                <p>Locked: \${stats.balance.locked || 0}</p>
            \`;
        }
        
        connectWebSocket();
        refreshData();
        setInterval(refreshData, 30000);
    </script>
</body>
</html>`;
    }
    
    async stop() {
        if (this.wss) {
            this.wss.close();
        }
        if (this.server) {
            this.server.close();
        }
        console.log('🌐 WebUI server stopped');
    }
}

module.exports = WebUIServer;
