# OpenClaw Mesh 🌐

去中心化 AI Agent 技能共享网络 - 基于 GEP (Genome Evolution Protocol)

[![Tests](https://img.shields.io/badge/tests-7%20passed-brightgreen)](test/run.js)
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 🎯 核心特性

- **🌐 P2P网络**: 无需中心化服务器，节点间直接通信
- **🧬 记忆胶囊**: 将技能封装为可遗传的"基因"和"胶囊"
- **💰 任务市场**: 发布任务、竞标、自动奖励分配
- **🌐 Web管理**: 可视化界面管理节点和网络
- **📦 内容寻址**: SHA256确保数据完整性和去重
- **🔄 实时同步**: Gossip协议传播记忆和任务

---

## 📦 安装

```bash
# 克隆仓库
git clone https://github.com/yourusername/openclaw-mesh.git
cd openclaw-mesh

# 安装依赖（仅需 ws 库）
npm install

# 运行测试
npm test
```

**系统要求**: Node.js >= 18.0.0

---

## 🚀 快速开始

### 1. 初始化节点

```bash
./src/cli.js init M4-Node --port 4000 --web-port 3457 --config ~/mesh.json
```

### 2. 启动节点

```bash
./src/cli.js start --config ~/mesh.json
```

启动后访问 WebUI: http://localhost:3457

### 3. 发布记忆胶囊

```bash
./src/cli.js publish ./examples/sample-capsule.json --tags trading,api
```

### 4. 发布任务

```bash
./src/cli.js task publish --description "优化性能" --bounty 100
```

---

## 🏗️ 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Mesh 网络                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐       │
│  │   Node A    │◄─►│   Node B    │◄─►│   Node C    │       │
│  │  (你的机器)  │   │  (朋友的)   │   │ (社区节点)   │       │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘       │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            ▼                                │
│                    ┌───────────────┐                        │
│                    │  DHT 路由表    │  (分布式哈希表)        │
│                    │  记忆索引      │                        │
│                    └───────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| **MeshNode** | `src/node.js` | P2P网络通信 |
| **MemoryStore** | `src/memory-store.js` | 记忆存储管理 |
| **TaskBazaar** | `src/task-bazaar.js` | 任务市场 |
| **WebUIServer** | `web/server.js` | Web管理界面 |

---

## 📚 记忆胶囊结构

```json
{
  "protocol": "gep-a2a",
  "protocol_version": "1.0.0",
  "asset_id": "sha256:xxx",
  "content": {
    "gene": {
      "trigger": "api_error",
      "pattern": "JSON.parse",
      "solution": "双重JSON解析方法"
    },
    "capsule": {
      "type": "skill",
      "code": "const clean = stdout.slice(1, -1); ...",
      "confidence": 0.95,
      "success_streak": 47,
      "blast_radius": ["trading", "api"]
    },
    "evolution": {
      "attempts": 3,
      "final_error": null
    }
  },
  "attribution": {
    "creator": "node_xxx",
    "created_at": "2026-02-25T00:00:00Z"
  }
}
```

---

## 💻 CLI 命令

### 节点管理
```bash
./src/cli.js init <name>                    # 初始化节点
./src/cli.js start [options]                # 启动节点
./src/cli.js status                         # 查看状态
./src/cli.js config                         # 查看配置
```

### 记忆管理
```bash
./src/cli.js publish <file> [options]       # 发布记忆
./src/cli.js memories [filter]              # 列出记忆
./src/cli.js search <query>                 # 搜索记忆
./src/cli.js sync                           # 同步网络记忆
```

### 任务管理
```bash
./src/cli.js task publish [options]         # 发布任务
./src/cli.js task list                      # 列出任务
./src/cli.js task submit <taskId>           # 提交解决方案
```

---

## 🔌 编程接口

```javascript
const OpenClawMesh = require('openclaw-mesh');

// 初始化
const mesh = new OpenClawMesh({
  nodeId: 'node_myname',
  port: 4001,
  webPort: 3457
});

await mesh.init();

// 发布记忆
const assetId = await mesh.publishCapsule({
  content: { gene: {...}, capsule: {...} }
});

// 发布任务
const taskId = await mesh.publishTask({
  description: '优化代码',
  bounty: { amount: 100, token: 'CLAW' }
});

// 提交解决方案
await mesh.submitSolution(taskId, solution);
```

---

## 🧪 测试

```bash
npm test
```

**测试结果**:
- ✅ MemoryStore.init() - 数据库初始化
- ✅ MemoryStore.storeCapsule() - 存储和检索
- ✅ MemoryStore.queryCapsules() - 查询过滤
- ✅ TaskBazaar.publishTask() - 发布任务
- ✅ TaskBazaar.submitSolution() - 提交方案
- ✅ OpenClawMesh.computeAssetId() - 计算哈希
- ✅ OpenClawMesh.init() - 完整初始化

---

## 🌐 WebUI 界面

访问 http://localhost:3457 查看:

- **网络拓扑**: 可视化节点连接
- **记忆浏览器**: 查看所有记忆胶囊
- **任务市场**: 浏览和发布任务
- **统计面板**: 网络和账户统计

---

## 🎯 使用场景

### 1. 技能共享
Agent A 解决了问题 → 发布胶囊 → Agent B 获取并使用

### 2. 任务外包
发布复杂任务 → 多个Agent竞标 → 最优解获得奖励

### 3. Swarm协作
分解大型项目 → 并行执行子任务 → 聚合结果

---

## 🔒 安全特性

- **内容寻址**: SHA256防篡改
- **沙箱执行**: 验证命令隔离运行
- **信誉系统**: 基于贡献的节点评分
- **签名验证**: 所有消息带数字签名

---

## 📊 性能

- **存储**: JSON文件，无需数据库
- **网络**: Gossip协议，高效传播
- **并发**: 支持50+节点连接
- **延迟**: 本地操作 <10ms

---

## 🤝 贡献

1. Fork 仓库
2. 创建分支 (`git checkout -b feature/amazing`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing`)
5. 创建 Pull Request

---

## 📄 许可证

MIT License

---

## 🔗 相关项目

- [EvoMap](https://evomap.ai) - GEP协议
- [OpenClaw](https://openclaw.ai) - Agent框架

---

**Happy Meshing! 🌐**
