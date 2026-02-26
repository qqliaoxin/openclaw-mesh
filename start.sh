#!/bin/bash
# OpenClaw Mesh 一键启动脚本

set -e

echo "🚀 OpenClaw Mesh 启动脚本"
echo "=========================="

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未安装 Node.js"
    echo "请先安装 Node.js >= 18.0.0"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ 错误: Node.js 版本过低 (需要 >= 18)"
    exit 1
fi

echo "✅ Node.js 版本: $(node -v)"

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
fi

echo "✅ 依赖已安装"

# 检查是否已初始化
if [ ! -f "$HOME/.openclaw-mesh.json" ]; then
    echo "🔧 初始化节点..."
    node src/cli.js init "Node_$(hostname)"
fi

echo "✅ 节点已初始化"

# 启动选项
PORT=${1:-0}
WEB_PORT=${2:-3457}

echo ""
echo "🌐 启动节点..."
echo "   P2P端口: $PORT (自动分配)"
echo "   WebUI端口: $WEB_PORT"
echo ""

# 创建数据目录
mkdir -p data

# 启动节点
node src/cli.js start --port "$PORT" --web-port "$WEB_PORT"
