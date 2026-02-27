/**
 * MeshNode - P2P网络节点
 * 基于简化版的Gossip协议实现
 */

const EventEmitter = require('events');
const net = require('net');
const crypto = require('crypto');

class MeshNode extends EventEmitter {
    constructor(options = {}) {
        super();
        this.nodeId = options.nodeId;
        this.port = options.port || 0;
        this.bootstrapNodes = options.bootstrapNodes || [];
        
        this.peers = new Map(); // peerId -> socket
        this.server = null;
        this.messageHandlers = new Map();
        this.seenMessages = new Map();
        this.seenTtlMs = options.seenTtlMs || 300000;
        this.maxSeenMessages = options.maxSeenMessages || 10000;
        this.peerStats = new Map();
        this.pendingPings = new Map();
        this.defaultFanout = options.fanout || 6;
        this.taskFanout = options.taskFanout || 8;
        this.defaultHops = options.defaultHops || 3;
        this.taskHops = options.taskHops || 4;
        
        this.setupMessageHandlers();
    }
    
    setupMessageHandlers() {
        // 处理新记忆胶囊
        this.messageHandlers.set('capsule', async (message, peerId) => {
            this.emit('memory:received', message.payload);
        });
        
        // 处理新任务
        this.messageHandlers.set('task', async (message, peerId) => {
            this.emit('task:received', message.payload);
        });
        
        // 处理任务竞价
        this.messageHandlers.set('task_bid', async (message, peerId) => {
            this.emit('task:bid', message.payload);
        });
        
        // 处理任务完成通知
        this.messageHandlers.set('task_completed', async (message, peerId) => {
            this.emit('task:completed', message.payload);
        });

        this.messageHandlers.set('task_assigned', async (message, peerId) => {
            this.emit('task:assigned', message.payload);
        });
        
        // 处理查询请求
        this.messageHandlers.set('query', async (message, peerId) => {
            const response = await this.handleQuery(message.payload);
            this.sendToPeer(peerId, {
                type: 'query_response',
                payload: response,
                requestId: message.requestId
            });
        });
        
        // 处理查询响应
        this.messageHandlers.set('query_response', async (message, peerId) => {
            this.emit(`query_response:${message.requestId}`, message.payload);
        });
        
        // 处理ping
        this.messageHandlers.set('ping', (message, peerId) => {
            const pong = {
                type: 'pong',
                timestamp: Date.now()
            };
            if (message.pingId) {
                pong.pingId = message.pingId;
            }
            this.sendToPeer(peerId, pong);
        });
        
        // 处理pong
        this.messageHandlers.set('pong', (message, peerId) => {
            if (message.pingId) {
                const pending = this.pendingPings.get(message.pingId);
                if (pending && pending.peerId === peerId) {
                    const rtt = Date.now() - pending.sentAt;
                    this.pendingPings.delete(message.pingId);
                    this.peerStats.set(peerId, { rtt, lastSeen: Date.now() });
                }
            }
            this.emit('peer:alive', peerId);
        });
    }
    
    async init() {
        return new Promise((resolve, reject) => {
            // 创建服务器
            this.server = net.createServer((socket) => {
                this.handleConnection(socket);
            });
            
            this.server.listen(this.port, () => {
                const address = this.server.address();
                this.port = address.port;
                console.log(`📡 P2P node listening on port ${this.port}`);
                
                // 连接到bootstrap节点
                this.connectToBootstrapNodes();
                
                // 启动心跳
                this.startHeartbeat();
                
                resolve();
            });
            
            this.server.on('error', reject);
        });
    }
    
    handleConnection(socket) {
        let buffer = '';
        let peerId = null;
        
        // Store socket immediately by remote address (temporary key)
        const remoteKey = socket.remoteAddress + ':' + socket.remotePort;
        this.peers.set(remoteKey, socket);
        
        socket.on('data', (data) => {
            buffer += data.toString();
            
            // 处理消息（按行分割）
            let lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整行
            
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const message = JSON.parse(line);
                        this.handleMessage(message, peerId || remoteKey);
                    } catch (e) {
                        console.error('Invalid message:', e.message);
                    }
                }
            }
        });
        
        socket.on('close', () => {
            if (peerId) {
                this.peers.delete(peerId);
                this.emit('peer:disconnected', peerId);
            }
            // Also remove by remote key
            this.peers.delete(remoteKey);
        });
        
        socket.on('error', (err) => {
            console.error('Socket error:', err.message);
        });
    }
    
    handleMessage(message, peerId) {
        // 更新peerId（如果是handshake消息）
        if (message.type === 'handshake') {
            const oldKey = peerId; // Could be remoteKey or address like "localhost:4001"
            
            // If peerId already looks like a nodeId (starts with node_), skip
            if (!oldKey.startsWith('node_')) {
                peerId = message.nodeId;
                
                // Update socket mapping - replace old key with nodeId
                const socket = this.peers.get(oldKey);
                if (socket) {
                    this.peers.delete(oldKey);
                    this.peers.set(peerId, socket);
                    
                    // Send handshake back for bidirectional connection (only if not already sent)
                    if (!oldKey.includes(this.nodeId)) {
                        this.send(socket, {
                            type: 'handshake',
                            nodeId: this.nodeId,
                            port: this.port
                        });
                    }
                }
            } else {
                peerId = message.nodeId;
            }
            this.emit('peer:connected', peerId);
        }

        if (!this.shouldProcessMessage(message)) {
            return;
        }
        
        const handler = this.messageHandlers.get(message.type);
        if (handler) {
            handler(message, peerId);
        }

        if (this.shouldRelayMessage(message)) {
            this.relayMessage(message, peerId);
        }
    }
    
    getSocketForPeer(peerId) {
        // Find socket by peerId - check peers Map first, then by iterating sockets
        if (this.peers.has(peerId)) {
            return this.peers.get(peerId);
        }
        // Fallback: try to find by remote address/ip
        for (const [id, sock] of this.peers) {
            if (id.includes(peerId) || peerId.includes(id)) {
                return sock;
            }
        }
        return null;
    }
    
    async connectToBootstrapNodes() {
        for (const addr of this.bootstrapNodes) {
            try {
                await this.connectToPeer(addr);
            } catch (e) {
                console.error(`Failed to connect to bootstrap ${addr}:`, e.message);
            }
        }
    }
    
    async connectToPeer(address) {
        return new Promise((resolve, reject) => {
            const [host, port] = address.split(':');
            const socket = net.createConnection({ host, port: parseInt(port) }, () => {
                // Store temporarily by address
                this.peers.set(address, socket);
                
                // 发送handshake
                this.send(socket, {
                    type: 'handshake',
                    nodeId: this.nodeId,
                    port: this.port
                });
                
                console.log(`🔗 Connected to peer: ${address}`);
                resolve();
            });
            
            // Handle incoming messages on this outgoing connection
            let buffer = '';
            socket.on('data', (data) => {
                buffer += data.toString();
                let lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const message = JSON.parse(line);
                            // Handle peer handshake response - update peer mapping
                            if (message.type === 'handshake' && message.nodeId) {
                                // Remove old address key, add nodeId
                                this.peers.delete(address);
                                this.peers.set(message.nodeId, socket);
                                console.log(`🔄 Mapped peer: ${message.nodeId}`);
                            }
                            this.handleMessage(message, message.nodeId || address);
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            });
            
            socket.on('error', reject);
            
            socket.on('close', () => {
                this.peers.delete(address);
            });
        });
    }
    
    send(socket, message) {
        if (socket && !socket.destroyed && socket.writable) {
            socket.write(JSON.stringify(message) + '\n');
        }
    }
    
    sendToPeer(peerId, message) {
        const socket = this.peers.get(peerId);
        if (socket && !socket.destroyed) {
            this.send(socket, message);
        } else {
            // Clean up stale peer
            this.peers.delete(peerId);
        }
    }
    
    // 广播胶囊到所有peer
    async broadcastCapsule(capsule) {
        const message = {
            type: 'capsule',
            payload: capsule,
            timestamp: Date.now()
        };
        this.broadcast(message, { fanout: this.defaultFanout, hopsLeft: this.defaultHops });
    }
    
    // 广播任务
    async broadcastTask(task) {
        const message = {
            type: 'task',
            payload: task,
            timestamp: Date.now()
        };
        this.broadcast(message, { fanout: this.taskFanout, hopsLeft: this.taskHops });
    }
    
    broadcast(message, options = {}) {
        const { fanout, excludePeerId, hopsLeft } = options;
        const peers = this.selectPeers(fanout || this.defaultFanout, excludePeerId);
        const messageId = this.ensureMessageId(message);
        this.markMessageSeen(messageId);
        for (const { peerId, socket } of peers) {
            try {
                if (socket && !socket.destroyed) {
                    const outbound = {
                        ...message,
                        messageId,
                        hopsLeft: typeof hopsLeft === 'number' ? hopsLeft : this.defaultHops
                    };
                    this.send(socket, outbound);
                } else {
                    this.peers.delete(peerId);
                }
            } catch (e) {
                console.error(`Failed to send to ${peerId}:`, e.message);
                this.peers.delete(peerId);
            }
        }
    }

    broadcastAll(message, options = {}) {
        const { excludePeerId, hopsLeft } = options;
        const messageId = this.ensureMessageId(message);
        this.markMessageSeen(messageId);
        for (const [peerId, socket] of this.peers) {
            if (excludePeerId && peerId === excludePeerId) continue;
            try {
                if (socket && !socket.destroyed) {
                    const outbound = {
                        ...message,
                        messageId,
                        hopsLeft: typeof hopsLeft === 'number' ? hopsLeft : this.defaultHops
                    };
                    this.send(socket, outbound);
                } else {
                    this.peers.delete(peerId);
                }
            } catch (e) {
                console.error(`Failed to send to ${peerId}:`, e.message);
                this.peers.delete(peerId);
            }
        }
    }
    
    // 查询网络中的记忆
    async queryMemories(filter = {}) {
        const requestId = crypto.randomUUID();
        const query = {
            type: 'query',
            payload: { type: 'memories', filter },
            requestId
        };
        
        // 发送查询到所有peer
        this.broadcastAll(query, { hopsLeft: 0 });
        
        // 等待响应（简化版，实际应该设置超时）
        return new Promise((resolve) => {
            const results = [];
            const timeout = setTimeout(() => resolve(results), 5000);
            
            this.once(`query_response:${requestId}`, (response) => {
                clearTimeout(timeout);
                resolve(response.memories || []);
            });
        });
    }
    
    async handleQuery(query) {
        // 本地查询（实际应该查询memory store）
        if (query.type === 'memories') {
            return { memories: [] };
        }
        return {};
    }
    
    startHeartbeat() {
        setInterval(() => {
            const now = Date.now();
            for (const [pingId, pending] of this.pendingPings) {
                if (now - pending.sentAt > 15000) {
                    this.pendingPings.delete(pingId);
                }
            }
            for (const [peerId, socket] of this.peers) {
                if (socket && !socket.destroyed) {
                    const pingId = crypto.randomUUID();
                    this.pendingPings.set(pingId, { peerId, sentAt: now });
                    this.send(socket, { type: 'ping', timestamp: now, pingId });
                } else {
                    // Remove stale peer
                    this.peers.delete(peerId);
                }
            }
        }, 30000); // 每30秒发送一次心跳
    }
    
    getPeers() {
        const peers = [];
        for (const [peerId, socket] of this.peers) {
            if (peerId.startsWith('node_')) {
                peers.push({
                    nodeId: peerId,
                    ip: socket.remoteAddress ? socket.remoteAddress.replace('::ffff:', '') : 'unknown',
                    connectedAt: Date.now()
                });
            }
        }
        return peers;
    }

    ensureMessageId(message) {
        if (!message.messageId) {
            message.messageId = crypto.randomUUID();
        }
        return message.messageId;
    }

    markMessageSeen(messageId) {
        if (!messageId) return;
        this.seenMessages.set(messageId, Date.now());
        this.cleanupSeenMessages();
    }

    cleanupSeenMessages() {
        const now = Date.now();
        for (const [messageId, seenAt] of this.seenMessages) {
            if (now - seenAt > this.seenTtlMs) {
                this.seenMessages.delete(messageId);
            }
        }
        while (this.seenMessages.size > this.maxSeenMessages) {
            const oldest = this.seenMessages.keys().next().value;
            if (!oldest) break;
            this.seenMessages.delete(oldest);
        }
    }

    shouldProcessMessage(message) {
        if (!message || !message.messageId) {
            return true;
        }
        if (this.seenMessages.has(message.messageId)) {
            return false;
        }
        this.markMessageSeen(message.messageId);
        return true;
    }

    shouldRelayMessage(message) {
        if (!message || !message.messageId) return false;
        if (message.type === 'handshake') return false;
        if (message.type === 'ping' || message.type === 'pong') return false;
        if (message.type === 'query' || message.type === 'query_response') return false;
        if (typeof message.hopsLeft !== 'number') return true;
        return message.hopsLeft > 0;
    }

    relayMessage(message, fromPeerId) {
        const nextHops = typeof message.hopsLeft === 'number' ? message.hopsLeft - 1 : this.defaultHops - 1;
        if (nextHops < 0) return;
        const fanout = message.type === 'task' ? this.taskFanout : this.defaultFanout;
        this.broadcast(message, {
            fanout,
            excludePeerId: fromPeerId,
            hopsLeft: nextHops
        });
    }

    selectPeers(fanout, excludePeerId) {
        const peers = [];
        for (const [peerId, socket] of this.peers) {
            if (excludePeerId && peerId === excludePeerId) continue;
            if (!socket || socket.destroyed) {
                this.peers.delete(peerId);
                continue;
            }
            const stats = this.peerStats.get(peerId);
            peers.push({ peerId, socket, rtt: stats?.rtt });
        }
        const withStats = peers.filter(p => typeof p.rtt === 'number');
        const withoutStats = peers.filter(p => typeof p.rtt !== 'number');
        withStats.sort((a, b) => a.rtt - b.rtt);
        for (let i = withoutStats.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [withoutStats[i], withoutStats[j]] = [withoutStats[j], withoutStats[i]];
        }
        const ordered = [...withStats, ...withoutStats];
        if (!fanout || fanout >= ordered.length) {
            return ordered;
        }
        return ordered.slice(0, fanout);
    }
    
    async stop() {
        // 关闭所有peer连接
        for (const [peerId, socket] of this.peers) {
            socket.destroy();
        }
        this.peers.clear();
        
        // 关闭服务器
        if (this.server) {
            this.server.close();
        }
        
        console.log('📡 P2P node stopped');
    }
}

module.exports = MeshNode;
