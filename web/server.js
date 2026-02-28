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
        } else if (url === '/api/account') {
            if (this.mesh) {
                const accountId = this.mesh.wallet?.accountId;
                data = {
                    accountId,
                    balance: this.mesh.ledger?.getBalance(accountId) || 0,
                    nonce: this.mesh.ledger?.getNonce(accountId) || 0,
                    publicKeyPem: this.mesh.wallet?.publicKeyPem || null
                };
            } else {
                data = { error: 'Mesh not initialized' };
            }
        } else if (url === '/api/account/export') {
            if (this.mesh) {
                const accountId = this.mesh.wallet?.accountId;
                data = {
                    version: 2,
                    exportedAt: new Date().toISOString(),
                    account: {
                        accountId,
                        publicKeyPem: this.mesh.wallet?.publicKeyPem || null,
                        balance: this.mesh.ledger?.getBalance(accountId) || 0,
                        nonce: this.mesh.ledger?.getNonce(accountId) || 0
                    }
                };
            } else {
                data = { error: 'Mesh not initialized' };
            }
        } else if (url === '/api/memories') {
            data = this.mesh ? this.sanitizeCapsules(this.mesh.memoryStore.queryCapsules({ limit: 50 })) : [];
        } else if (url === '/api/tasks') {
            if (this.mesh) {
                const tasks = this.mesh.taskBazaar.getTasks();
                data = tasks.map(t => ({
                    ...t,
                    liked: this.mesh.ratingStore?.hasLike?.(t.taskId) || false
                }));
            } else {
                data = [];
            }
        } else if (url === '/api/peers') {
            data = this.mesh ? this.mesh.node.getPeers() : [];
        } else if (url.startsWith('/api/memory/')) {
            const assetId = url.split('/').pop();
            data = this.mesh ? this.sanitizeCapsule(this.mesh.memoryStore.getCapsule(assetId)) : null;
        } else if (url === '/api/stats') {
            const platformAccountId = this.mesh?.getPlatformAccountId?.();
            const rating = this.mesh?.ratingStore?.getNode?.(this.mesh?.options?.nodeId) || null;
            const ratingRules = this.mesh?.ratingStore?.getRules?.() || null;
            data = {
                memories: this.mesh ? this.mesh.memoryStore.getStats() : {},
                tasks: this.mesh ? this.mesh.taskBazaar.getStats() : {},
                balance: this.mesh ? this.mesh.taskBazaar.getBalance() : {},
                platformBalance: platformAccountId ? (this.mesh.ledger?.getBalance(platformAccountId) || 0) : 0,
                taskPublishFee: this.mesh?.options?.taskPublishFee || 0,
                capsulePublishFee: this.mesh?.options?.capsulePublishFee || 0,
                rating,
                ratingRules
            };
        } else if (url.startsWith('/api/tx/status')) {
            const query = url.split('?')[1] || '';
            const params = new URLSearchParams(query);
            const txId = params.get('txId');
            if (!txId) {
                data = { error: 'Missing txId' };
            } else if (this.mesh) {
                data = this.mesh.getTxStatus(txId);
            } else {
                data = { error: 'Mesh not initialized' };
            }
        } else if (url.startsWith('/api/tx/recent')) {
            const query = url.split('?')[1] || '';
            const params = new URLSearchParams(query);
            const limit = Number(params.get('limit') || 20);
            if (this.mesh) {
                const rows = this.mesh.ledger?.getRecentTxs(limit) || [];
                const withConfirmations = rows.map(r => ({
                    ...r,
                    confirmations: this.mesh.ledger?.getConfirmations(r.txId) || 0
                }));
                data = { items: withConfirmations };
            } else {
                data = { error: 'Mesh not initialized' };
            }
        } else if (url === '/api/tx/config') {
            if (req.method === 'GET') {
                data = {
                    confirmations: this.mesh?.options?.txConfirmations || {},
                    timeouts: this.mesh?.options?.txTimeoutMs || {}
                };
            } else if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const payload = JSON.parse(body || '{}');
                        if (this.mesh) {
                            if (payload.confirmations) {
                                this.mesh.options.txConfirmations = { ...this.mesh.options.txConfirmations, ...payload.confirmations };
                            }
                            if (payload.timeouts) {
                                this.mesh.options.txTimeoutMs = { ...this.mesh.options.txTimeoutMs, ...payload.timeouts };
                            }
                            data = { success: true, confirmations: this.mesh.options.txConfirmations, timeouts: this.mesh.options.txTimeoutMs };
                        } else {
                            data = { error: 'Mesh not initialized' };
                        }
                    } catch (e) {
                        data = { error: e.message };
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify(data));
                });
                return;
            }
        } else if (url === '/api/snapshot') {
            if (this.mesh?.options?.isGenesisNode) {
                data = this.mesh.memoryStore.getSnapshot();
            } else {
                data = { error: 'Not authorized' };
            }
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
                        const taskId = await this.mesh.publishTask({
                            description: payload.description,
                            bounty: { amount: payload.bounty || 100, token: 'CLAW' },
                            tags: payload.tags || [],
                            publisher: payload.publisher
                        });
                        const task = this.mesh.taskBazaar.getTask(taskId.taskId || taskId);
                        data = { success: true, task, taskId: taskId.taskId || taskId, txReceipts: taskId.txReceipts || [] };
                    } else {
                        data = { error: 'Mesh not initialized' };
                    }
                } catch (e) {
                    data = { error: e.message };
                }
                res.writeHead(200);
                res.end(JSON.stringify(data));
            });
            return;
        } else if (url === '/api/task/like' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body || '{}');
                    if (!this.mesh) {
                        data = { error: 'Mesh not initialized' };
                    } else {
                        const task = this.mesh.taskBazaar.getTask(payload.taskId);
                        const winnerNodeId = task?.completedBy || task?.winner;
                        if (!task || task.status !== 'completed' || !winnerNodeId) {
                            data = { error: 'Task not eligible for like' };
                        } else {
                            const likedBy = payload.likedBy || this.mesh.options.nodeId;
                            const result = this.mesh.ratingStore.addLike(task.taskId, winnerNodeId, likedBy);
                            if (result.ok) {
                                if (this.mesh.node && this.mesh.node.broadcast) {
                                    this.mesh.node.broadcast({
                                        type: 'task_like',
                                        payload: { taskId: task.taskId, winnerNodeId, likedBy }
                                    });
                                }
                                data = { success: true };
                            } else {
                                data = { error: result.reason || 'Already liked' };
                            }
                        }
                    }
                } catch (e) {
                    data = { error: e.message };
                }
                res.writeHead(200);
                res.end(JSON.stringify(data));
            });
            return;
        } else if (url === '/api/account/import' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    data = { error: 'Account import disabled. Private keys never leave the node.' };
                } catch (e) {
                    data = { error: e.message };
                }
                res.writeHead(200);
                res.end(JSON.stringify(data));
            });
            return;
        } else if (url === '/api/account/transfer' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    if (this.mesh) {
                        const toAccountId = payload.toAccountId;
                        const amount = Number(payload.amount);
                        if (!toAccountId || !Number.isFinite(amount) || amount <= 0) {
                            data = { error: 'Invalid transfer payload' };
                        } else {
                            const tx = this.mesh.createSignedTransfer(toAccountId, amount);
                            const result = this.mesh.submitTx(tx);
                            data = { success: true, result, txId: tx.txId };
                        }
                    } else {
                        data = { error: 'Mesh not initialized' };
                    }
                } catch (e) {
                    data = { error: e.message };
                }
                res.writeHead(200);
                res.end(JSON.stringify(data));
            });
            return;
        } else if (url === '/api/memory/publish' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    if (this.mesh) {
                        const assetId = await this.mesh.publishCapsule({
                            content: payload.content,
                            type: payload.type || 'repair',
                            tags: payload.tags || [],
                            price: payload.price,
                            attribution: payload.publisher ? { creator: payload.publisher } : undefined
                        });
                        const capsule = this.mesh.memoryStore.getCapsule(assetId.assetId || assetId);
                        data = { success: true, capsule, assetId: assetId.assetId || assetId, txReceipts: assetId.txReceipts || [] };
                    } else {
                        data = { error: 'Mesh not initialized' };
                    }
                } catch (e) {
                    data = { error: e.message };
                }
                res.writeHead(200);
                res.end(JSON.stringify(data));
            });
            return;
        } else if (url === '/api/capsule/purchase' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    if (this.mesh) {
                        const result = await this.mesh.purchaseCapsule(payload.assetId, payload.buyerNodeId);
                        data = { success: true, capsule: result.capsule, txReceipts: result.txReceipts };
                    } else {
                        data = { error: 'Mesh not initialized' };
                    }
                } catch (e) {
                    data = { error: e.message };
                }
                res.writeHead(200);
                res.end(JSON.stringify(data));
            });
            return;
        }
        
        res.writeHead(200);
        res.end(JSON.stringify(data));
    }

    sanitizeCapsules(capsules) {
        if (!Array.isArray(capsules)) return [];
        return capsules.map(capsule => this.sanitizeCapsule(capsule));
    }

    sanitizeCapsule(capsule) {
        if (!capsule) return null;
        if (this.mesh?.options?.isGenesisNode) {
            return capsule;
        }
        return {
            ...capsule,
            content: null
        };
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
                    repair: 'Repair', optimize: 'Optimize', innovate: 'Innovate', working: 'Working',
                    accountTab: 'Account', accountTitle: 'Account', accountId: 'Account ID', algorithm: 'Algorithm',
                    createdAt: 'Created At', accountBalance: 'Balance', exportAccount: 'Export Account',
                    importAccount: 'Import Account', importHint: 'Paste JSON or choose file', chooseFile: 'Choose File',
                    price: 'Price', action: 'Action', buy: 'Buy', capsulePrice: 'Price (CLAW):',
                    transfer: 'Transfer', toAccountId: 'To Account ID', amount: 'Amount', transferSubmit: 'Send'
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
                    repair: '修复', optimize: '优化', innovate: '创新', working: '处理中',
                    accountTab: '账户', accountTitle: '账户信息', accountId: '账户ID', algorithm: '算法',
                    createdAt: '创建时间', accountBalance: '余额', exportAccount: '导出账户',
                    importAccount: '导入账户', importHint: '粘贴JSON或选择文件', chooseFile: '选择文件',
                    price: '价格', action: '操作', buy: '购买', capsulePrice: '价格 (CLAW)：',
                    transfer: '转账', toAccountId: '转入账户ID', amount: '金额', transferSubmit: '发送'
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
            <button class="tab" onclick="switchTab('account')" data-i18n="accountTab">Account</button>
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
                            <th data-i18n="price">Price</th>
                            <th data-i18n="action">Action</th>
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
                            <th>Like</th>
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
                        <label>Publish Fee (CLAW):</label>
                        <div><span id="taskPublishFee">0</span></div>
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
                        <label data-i18n="capsulePrice">Price (CLAW):</label>
                        <input type="number" id="capsulePrice" min="0" value="10">
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

        <div id="account" class="tab-content">
            <div class="card">
                <h2 data-i18n="accountTitle">Account</h2>
                <table>
                    <tbody>
                        <tr>
                            <th data-i18n="accountId">Account ID</th>
                            <td id="accountId">-</td>
                        </tr>
                        <tr>
                            <th data-i18n="algorithm">Algorithm</th>
                            <td id="accountAlgorithm">-</td>
                        </tr>
                        <tr>
                            <th data-i18n="createdAt">Created At</th>
                            <td id="accountCreatedAt">-</td>
                        </tr>
                        <tr>
                            <th data-i18n="accountBalance">Balance</th>
                            <td id="accountBalance">-</td>
                        </tr>
                    </tbody>
                </table>
                <div style="margin-top:20px;display:flex;gap:12px;flex-wrap:wrap;">
                    <button class="btn" onclick="exportAccount()" data-i18n="exportAccount">Export Account</button>
                    <input type="file" id="accountFile" accept="application/json" style="color:#fff;">
                </div>
                <div class="form-group" style="margin-top:16px;">
                    <label data-i18n="importHint">Paste JSON or choose file</label>
                    <textarea id="accountJson" rows="4" placeholder="{ }"></textarea>
                </div>
                <button class="btn" onclick="importAccount()" data-i18n="importAccount">Import Account</button>
                <div id="accountResult" style="margin-top: 10px;"></div>
            </div>
            <div class="card" style="margin-top:20px;">
                <h2 data-i18n="transfer">Transfer</h2>
                <div class="form-group">
                    <label data-i18n="toAccountId">To Account ID</label>
                    <input type="text" id="transferToAccountId" placeholder="acct_xxx">
                </div>
                <div class="form-group">
                    <label data-i18n="amount">Amount</label>
                    <input type="number" id="transferAmount" min="1" value="1">
                </div>
                <button class="btn" onclick="transferAccount()" data-i18n="transferSubmit">Send</button>
                <div id="transferResult" style="margin-top: 10px;"></div>
            </div>
        </div>
        
        <div id="stats" class="tab-content">
            <div class="card">
                <h2 data-i18n="detailedStats">Detailed Statistics</h2>
                <div id="detailedStats"></div>
                <div style="margin-top:16px;">
                    <button class="btn" onclick="openTxModal()">Tx Status</button>
                </div>
                <div style="margin-top:20px;">
                    <h3>Node Rating</h3>
                    <div id="ratingInfo"></div>
                    <div id="ratingRules" style="margin-top:10px;color:#9fb0c4;"></div>
                </div>
                <div style="margin-top:16px;">
                    <h3>Tx Confirm Config</h3>
                    <div class="form-group">
                        <label>Transfer Confirmations</label>
                        <input type="number" id="cfgConfirmTransfer" min="1" value="1">
                    </div>
                    <div class="form-group">
                        <label>Transfer Timeout (ms)</label>
                        <input type="number" id="cfgTimeoutTransfer" min="1000" value="8000">
                    </div>
                    <div class="form-group">
                        <label>Task Publish Confirmations</label>
                        <input type="number" id="cfgConfirmTask" min="1" value="1">
                    </div>
                    <div class="form-group">
                        <label>Task Publish Timeout (ms)</label>
                        <input type="number" id="cfgTimeoutTask" min="1000" value="8000">
                    </div>
                    <div class="form-group">
                        <label>Capsule Publish Confirmations</label>
                        <input type="number" id="cfgConfirmCapsule" min="1" value="1">
                    </div>
                    <div class="form-group">
                        <label>Capsule Publish Timeout (ms)</label>
                        <input type="number" id="cfgTimeoutCapsule" min="1000" value="8000">
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <button class="btn" onclick="saveTxConfig()">Save</button>
                        <button class="btn" onclick="loadTxConfig()">Reload</button>
                    </div>
                    <div id="txConfigResult" style="margin-top:10px;"></div>
                </div>
                <div style="margin-top:20px;">
                    <h3>Recent Transactions</h3>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                        <input type="text" id="txFilterId" placeholder="Filter Tx ID">
                        <input type="text" id="txFilterType" placeholder="Filter Type">
                        <input type="number" id="txFilterMin" placeholder="Min Amount">
                        <input type="number" id="txFilterMax" placeholder="Max Amount">
                        <button class="btn" onclick="applyTxFilters()">Apply</button>
                    </div>
                    <table id="txHistoryTable">
                        <thead>
                            <tr>
                                <th>Seq</th>
                                <th>Tx ID</th>
                                <th>Type</th>
                                <th>Amount</th>
                                <th>Confirmations</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <div id="txModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:999;">
        <div style="max-width:520px;margin:8% auto;background:#151515;padding:20px;border-radius:12px;border:1px solid #2a2a2a;">
            <h3 style="margin-top:0;">Tx Status</h3>
            <div class="form-group">
                <label>Tx ID</label>
                <input type="text" id="txStatusInput" placeholder="txId">
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn" onclick="startTxStatus()">Check</button>
                <button class="btn" onclick="closeTxModal()">Close</button>
            </div>
            <div id="txStatusResult" style="margin-top:12px;"></div>
        </div>
    </div>
    
    <button class="refresh-btn" onclick="refreshData()">↻</button>
    
    <script>
        let ws;
        let currentNodeId = null;
        let txStatusInterval = null;
        const confirmTargets = {
            transfer: { target: 1, timeoutMs: 8000 },
            taskPublish: { target: 1, timeoutMs: 8000 },
            capsulePublish: { target: 1, timeoutMs: 8000 }
        };
        let txFilters = { id: '', type: '', min: null, max: null };
        
        function connectWebSocket() {
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = wsProtocol + '//' + window.location.host;
            ws = new WebSocket(wsUrl);
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'status') {
                    updateUI(data.data);
                }
            };
            
            ws.onerror = () => {
                console.warn('WebSocket error');
            };

            ws.onclose = () => {
                setTimeout(connectWebSocket, 3000);
            };
        }
        
        window.switchTab = function(tabName) {
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
                updateFees(stats);
                await loadTxConfig();

                const account = await fetch('/api/account').then(r => r.json());
                updateAccount(account);

                const txHistory = await fetch('/api/tx/recent?limit=20').then(r => r.json());
                updateTxHistory(txHistory.items || []);
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
            currentNodeId = data.nodeId || null;
            
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
                    <td>\${m.price?.amount || 0} \${m.price?.token || 'CLAW'}</td>
                    <td>
                        <button class="btn-small" onclick="purchaseCapsule('\${m.asset_id}')">💳 \${t('buy')}</button>
                    </td>
                </tr>
            \`).join('');
        }
        
        function updateTasks(tasks) {
            const tbody = document.querySelector('#tasksTable tbody');
            const rows = tasks.slice(0, 10).map(t => {
                const statusText = t.status === 'completed'
                    ? (currentLang === 'zh' ? '已完成' : t.status)
                    : t.status === 'working'
                        ? (currentLang === 'zh' ? '处理中' : t.status)
                        : (currentLang === 'zh' ? '开放' : t.status);
                const badgeClass = t.status === 'completed' ? 'success' : (t.status === 'working' ? 'info' : 'pending');
                const downloadBtn = t.status === 'completed'
                    ? '<button class="btn-small" onclick="downloadTask(\\'' + t.taskId + '\\')">⬇ ' + (currentLang === 'zh' ? '下载' : 'Download') + '</button>'
                    : '';
                const likeBtn = t.status === 'completed'
                    ? (t.liked ? '<span style="color:#7ee787">✔</span>' : '<button class="btn-small" onclick="likeTask(\\'' + t.taskId + '\\')">👍</button>')
                    : '';
                return '<tr>'
                    + '<td style="font-family:monospace;font-size:12px;">' + t.taskId.slice(0, 20) + '...</td>'
                    + '<td>' + t.description.slice(0, 40) + (t.description.length > 40 ? '...' : '') + '</td>'
                    + '<td>' + (t.bounty?.amount || 0) + ' ' + (t.bounty?.token || 'CLAW') + '</td>'
                    + '<td><span class="badge badge-' + badgeClass + '">' + statusText + '</span> ' + downloadBtn + '</td>'
                    + '<td>' + likeBtn + '</td>'
                    + '</tr>';
            });
            tbody.innerHTML = rows.join('');
        }

        function updateAccount(account) {
            if (!account || account.error) {
                document.getElementById('accountId').textContent = '-';
                document.getElementById('accountAlgorithm').textContent = '-';
                document.getElementById('accountCreatedAt').textContent = '-';
                document.getElementById('accountBalance').textContent = '-';
                return;
            }
            document.getElementById('accountId').textContent = account.accountId || '-';
            document.getElementById('accountAlgorithm').textContent = account.algorithm || '-';
            document.getElementById('accountCreatedAt').textContent = account.createdAt || '-';
            document.getElementById('accountBalance').textContent = typeof account.balance === 'number' ? account.balance : '-';
        }
        
        function downloadTask(taskId) {
            window.location.href = '/api/tasks/' + taskId + '/download';
        }

        async function exportAccount() {
            try {
                const res = await fetch('/api/account/export');
                const data = await res.json();
                if (data.error) {
                    document.getElementById('accountResult').innerHTML = '<span style="color:red">❌ ' + data.error + '</span>';
                    return;
                }
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'openclaw-account-backup.json';
                link.click();
                URL.revokeObjectURL(url);
                document.getElementById('accountResult').innerHTML = '<span style="color:green">✅ ' + (currentLang === 'zh' ? '账户已导出' : 'Account exported') + '</span>';
            } catch (e) {
                document.getElementById('accountResult').innerHTML = '<span style="color:red">❌ ' + e.message + '</span>';
            }
        }

        async function importAccount() {
            const fileInput = document.getElementById('accountFile');
            const textInput = document.getElementById('accountJson');
            let payloadText = textInput.value.trim();
            if (!payloadText && fileInput.files && fileInput.files[0]) {
                payloadText = await fileInput.files[0].text();
            }
            if (!payloadText) {
                document.getElementById('accountResult').innerHTML = '<span style="color:red">❌ ' + (currentLang === 'zh' ? '请提供账户JSON' : 'Provide account JSON') + '</span>';
                return;
            }
            try {
                const payload = JSON.parse(payloadText);
                const res = await fetch('/api/account/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                document.getElementById('accountResult').innerHTML = data.success
                    ? '<span style="color:green">✅ ' + (currentLang === 'zh' ? '账户已导入' : 'Account imported') + '</span>'
                    : '<span style="color:red">❌ ' + (data.error || 'Failed') + '</span>';
                if (data.success) {
                    textInput.value = '';
                    fileInput.value = '';
                    updateAccount(data.account);
                }
            } catch (e) {
                document.getElementById('accountResult').innerHTML = '<span style="color:red">❌ ' + e.message + '</span>';
            }
        }

        async function waitForTx(txId, target = 1, timeoutMs = 8000, intervalMs = 300) {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
                const status = await fetch('/api/tx/status?txId=' + encodeURIComponent(txId)).then(r => r.json());
                if (status.confirmations >= target) {
                    return status;
                }
                await new Promise(r => setTimeout(r, intervalMs));
            }
            return await fetch('/api/tx/status?txId=' + encodeURIComponent(txId)).then(r => r.json());
        }

        function renderTxReceipts(receipts) {
            if (!receipts || receipts.length === 0) return '';
            return receipts.map(r => 'Tx ' + r.txId.slice(0, 8) + '… confirmations: ' + r.confirmations).join('<br>');
        }

        async function transferAccount() {
            const toAccountId = document.getElementById('transferToAccountId').value.trim();
            const amount = Number(document.getElementById('transferAmount').value);
            const fromAccountId = document.getElementById('accountId').textContent.trim();
            if (!toAccountId || !Number.isFinite(amount) || amount <= 0) {
                document.getElementById('transferResult').innerHTML = '<span style="color:red">❌ ' + (currentLang === 'zh' ? '请输入账户ID和金额' : 'Provide account ID and amount') + '</span>';
                return;
            }
            try {
                const res = await fetch('/api/account/transfer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toAccountId, amount, fromAccountId })
                });
                const data = await res.json();
                if (data.success) {
                    let message = currentLang === 'zh' ? '✅ 转账成功' : '✅ Transfer completed';
                    if (data.txId) {
                        const cfg = confirmTargets.transfer;
                        const status = await waitForTx(data.txId, cfg.target, cfg.timeoutMs);
                        message += ' (confirmations: ' + (status.confirmations || 0) + ')';
                        if (!status.confirmed) {
                            message += ' ⚠️ Confirmation timeout';
                        }
                    }
                    document.getElementById('transferResult').innerHTML = '<span style="color:green">' + message + '</span>';
                } else {
                    document.getElementById('transferResult').innerHTML = '<span style="color:red">❌ ' + (data.error || 'Failed') + '</span>';
                }
                if (data.success) {
                    document.getElementById('transferToAccountId').value = '';
                    document.getElementById('transferAmount').value = 1;
                    refreshData();
                }
            } catch (e) {
                document.getElementById('transferResult').innerHTML = '<span style="color:red">❌ ' + e.message + '</span>';
            }
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
                if (data.success) {
                    let message = successMessage;
                    if (data.txReceipts && data.txReceipts.length > 0) {
                        const timeouts = data.txReceipts.filter(r => !r.confirmed).length;
                        message += '<br>' + renderTxReceipts(data.txReceipts);
                        if (timeouts > 0) {
                            message += '<br><span style="color:#f5c542">⚠️ Confirmation timeout</span>';
                        }
                    }
                    document.getElementById('publishResult').innerHTML = '<span style="color:green">' + message + '</span>';
                } else {
                    document.getElementById('publishResult').innerHTML = '<span style="color:red">❌ ' + (data.error || 'Failed') + '</span>';
                }
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
            const price = Number(document.getElementById('capsulePrice').value || 0);
            
            try {
                const res = await fetch('/api/memory/publish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, type, tags, price: { amount: price, token: 'CLAW' } })
                });
                const data = await res.json();
                if (data.success) {
                    let message = '✅ Capsule published successfully!';
                    if (data.txReceipts && data.txReceipts.length > 0) {
                        message += '<br>' + renderTxReceipts(data.txReceipts);
                        const timeouts = data.txReceipts.filter(r => !r.confirmed).length;
                        if (timeouts > 0) {
                            message += '<br><span style="color:#f5c542">⚠️ Confirmation timeout</span>';
                        }
                    }
                    document.getElementById('capsuleResult').innerHTML = '<span style="color:green">' + message + '</span>';
                } else {
                    document.getElementById('capsuleResult').innerHTML = '<span style="color:red">❌ ' + (data.error || 'Failed') + '</span>';
                }
                if (data.success) {
                    document.getElementById('capsuleForm').reset();
                    refreshData();
                }
            } catch (e) {
                document.getElementById('capsuleResult').innerHTML = '<span style="color:red">❌ Error: ' + e.message + '</span>';
            }
        }

        async function purchaseCapsule(assetId) {
            try {
                const res = await fetch('/api/capsule/purchase', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assetId, buyerNodeId: currentNodeId })
                });
                const data = await res.json();
                if (!data.success) {
                    alert(data.error || 'Purchase failed');
                    return;
                }
                if (data.txReceipts && data.txReceipts.length > 0) {
                    const timeouts = data.txReceipts.filter(r => !r.confirmed).length;
                    let msg = 'Purchase confirmed.\\n' + data.txReceipts.map(r => 'Tx ' + r.txId.slice(0, 8) + '… confirmations: ' + r.confirmations).join('\\n');
                    if (timeouts > 0) msg += '\\n⚠️ Confirmation timeout';
                    alert(msg);
                }
                const blob = new Blob([JSON.stringify(data.capsule, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = assetId + '.json';
                link.click();
                URL.revokeObjectURL(url);
            } catch (e) {
                alert(e.message);
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
                <p>Platform Balance: \${stats.platformBalance || 0}</p>
            \`;
            const rating = stats.rating || {};
            const info = [
                'Score: ' + (rating.score !== undefined ? rating.score : 0),
                'Completed: ' + (rating.completed !== undefined ? rating.completed : 0),
                'Failed: ' + (rating.failed !== undefined ? rating.failed : 0),
                'Likes: ' + (rating.likes !== undefined ? rating.likes : 0),
                'EWMA: ' + Math.round(rating.ewma || 0)
            ].join('<br>');
            document.getElementById('ratingInfo').innerHTML = info;
            const rules = stats.ratingRules || {};
            if (rules && Object.keys(rules).length > 0) {
                const rulesText = [
                    'EWMA alpha: ' + (rules.alpha !== undefined ? rules.alpha : '-'),
                    'Target ms: ' + (rules.targetMs !== undefined ? rules.targetMs : '-'),
                    'Max speed score: ' + (rules.maxSpeedScore !== undefined ? rules.maxSpeedScore : 10000),
                    'Points per task: ' + (rules.pointsPerTask !== undefined ? rules.pointsPerTask : 2),
                    'Penalty per fail: ' + (rules.penaltyPerFail !== undefined ? rules.penaltyPerFail : 10),
                    'Like points: ' + (rules.likePoints !== undefined ? rules.likePoints : 1),
                    'Min tasks to enforce: ' + (rules.minTasks !== undefined ? rules.minTasks : 10),
                    'Disqualify threshold: ' + (rules.threshold !== undefined ? rules.threshold : 10)
                ].join('<br>');
                document.getElementById('ratingRules').innerHTML = rulesText;
            }
        }

        function updateTxHistory(items) {
            const tbody = document.querySelector('#txHistoryTable tbody');
            if (!tbody) return;
            if (!items || items.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5">No transactions</td></tr>';
                return;
            }
            const filtered = items.filter(tx => {
                if (txFilters.id && !tx.txId.includes(txFilters.id)) return false;
                if (txFilters.type && tx.type !== txFilters.type) return false;
                const amt = Number(tx.amount || 0);
                if (Number.isFinite(txFilters.min) && amt < txFilters.min) return false;
                if (Number.isFinite(txFilters.max) && amt > txFilters.max) return false;
                return true;
            });
            tbody.innerHTML = (filtered.length ? filtered : items).map(tx =>
                '<tr>'
                + '<td>' + tx.seq + '</td>'
                + '<td><a href="#" onclick="openTxStatus(\\'' + tx.txId + '\\');return false;">' + tx.txId.slice(0, 8) + '...</a></td>'
                + '<td>' + tx.type + '</td>'
                + '<td>' + tx.amount + '</td>'
                + '<td>' + (tx.confirmations || 0) + '</td>'
                + '</tr>'
            ).join('');
        }

        function updateFees(stats) {
            const feeEl = document.getElementById('taskPublishFee');
            if (feeEl) {
                feeEl.textContent = stats.taskPublishFee || 0;
            }
        }

        function openTxModal() {
            document.getElementById('txModal').style.display = 'block';
            document.getElementById('txStatusResult').innerHTML = '';
            if (txStatusInterval) clearInterval(txStatusInterval);
        }

        function closeTxModal() {
            document.getElementById('txModal').style.display = 'none';
            if (txStatusInterval) {
                clearInterval(txStatusInterval);
                txStatusInterval = null;
            }
        }

        function openTxStatus(txId) {
            openTxModal();
            document.getElementById('txStatusInput').value = txId;
            startTxStatus();
        }

        async function startTxStatus() {
            const txId = document.getElementById('txStatusInput').value.trim();
            if (!txId) {
                document.getElementById('txStatusResult').innerHTML = '<span style="color:red">❌ Missing txId</span>';
                return;
            }
            if (txStatusInterval) clearInterval(txStatusInterval);
            const update = async () => {
                const status = await fetch('/api/tx/status?txId=' + encodeURIComponent(txId)).then(r => r.json());
            const msg = 'Confirmations: ' + (status.confirmations || 0) + (status.confirmed ? '' : ' ⚠️ Confirmation timeout');
                document.getElementById('txStatusResult').innerHTML = '<span>' + msg + '</span>';
            };
            document.getElementById('txStatusResult').innerHTML = '<span>Checking...</span>';
            await update();
            txStatusInterval = setInterval(update, 1000);
        }

        async function likeTask(taskId) {
            try {
                const res = await fetch('/api/task/like', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId })
                });
                const data = await res.json();
                if (!data.success) {
                    alert(data.error || 'Like failed');
                    return;
                }
                refreshData();
            } catch (e) {
                alert(e.message);
            }
        }

        function applyTxFilters() {
            txFilters = {
                id: document.getElementById('txFilterId').value.trim(),
                type: document.getElementById('txFilterType').value.trim(),
                min: document.getElementById('txFilterMin').value ? Number(document.getElementById('txFilterMin').value) : null,
                max: document.getElementById('txFilterMax').value ? Number(document.getElementById('txFilterMax').value) : null
            };
            refreshData();
        }

        async function loadTxConfig() {
            const cfg = await fetch('/api/tx/config').then(r => r.json());
            if (cfg.confirmations) {
                confirmTargets.transfer.target = cfg.confirmations.transfer || 1;
                confirmTargets.taskPublish.target = cfg.confirmations.taskPublish || 1;
                confirmTargets.capsulePublish.target = cfg.confirmations.capsulePublish || 1;
                document.getElementById('cfgConfirmTransfer').value = confirmTargets.transfer.target;
                document.getElementById('cfgConfirmTask').value = confirmTargets.taskPublish.target;
                document.getElementById('cfgConfirmCapsule').value = confirmTargets.capsulePublish.target;
            }
            if (cfg.timeouts) {
                confirmTargets.transfer.timeoutMs = cfg.timeouts.transfer || 8000;
                confirmTargets.taskPublish.timeoutMs = cfg.timeouts.taskPublish || 8000;
                confirmTargets.capsulePublish.timeoutMs = cfg.timeouts.capsulePublish || 8000;
                document.getElementById('cfgTimeoutTransfer').value = confirmTargets.transfer.timeoutMs;
                document.getElementById('cfgTimeoutTask').value = confirmTargets.taskPublish.timeoutMs;
                document.getElementById('cfgTimeoutCapsule').value = confirmTargets.capsulePublish.timeoutMs;
            }
        }

        async function saveTxConfig() {
            const payload = {
                confirmations: {
                    transfer: Number(document.getElementById('cfgConfirmTransfer').value || 1),
                    taskPublish: Number(document.getElementById('cfgConfirmTask').value || 1),
                    capsulePublish: Number(document.getElementById('cfgConfirmCapsule').value || 1)
                },
                timeouts: {
                    transfer: Number(document.getElementById('cfgTimeoutTransfer').value || 8000),
                    taskPublish: Number(document.getElementById('cfgTimeoutTask').value || 8000),
                    capsulePublish: Number(document.getElementById('cfgTimeoutCapsule').value || 8000)
                }
            };
            const res = await fetch('/api/tx/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            document.getElementById('txConfigResult').innerHTML = data.success
                ? '<span style="color:green">✅ Saved</span>'
                : '<span style="color:red">❌ ' + (data.error || 'Failed') + '</span>';
            await loadTxConfig();
        }
        
        window.addEventListener('load', () => {
            try { connectWebSocket(); } catch (e) { console.error('WS init failed:', e); }
            try { refreshData(); } catch (e) { console.error('Initial refresh failed:', e); }
            setInterval(() => {
                try { refreshData(); } catch (e) { console.error('Refresh failed:', e); }
            }, 30000);
        });
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
