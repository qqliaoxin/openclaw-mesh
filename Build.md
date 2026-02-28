安装依赖（新增 better-sqlite3）：
npm install
建议清空旧数据（否则旧账户/账本会干扰）：
删除各节点 dataDir 里的旧文件（至少 ledger.sqlite、wallet.json）
启动节点：
# Genesis
./src/cli.js init Genesis-Node --genesis --port 4000 --web-port 3457 --config ~/genesis.json
./src/cli.js start --config ~/genesis.json
# Follower
./src/cli.js start --config ~/mesh1.json --bootstrap localhost:4000
获取收款账户（用新钱包）：
./src/cli.js --config ~/mesh2.json account export
发布任务（会自动锁定 escrow）：
./src/cli.js task publish --description "test task" --bounty 100
提交方案（主节点会释放 escrow）：
./src/cli.js task submit <task_id>
重启所有节点（确保 follower 与主节点连接后完成 tx_log 同步）

测试发布费和购买：

# 发布胶囊（会扣发布费）
./src/cli.js publish ./examples/sample-capsule.json

# 购买胶囊（会按比例给作者 + 平台）
./src/cli.js purchase <asset_id>   # 或 WebUI 购买

1) UI 显示平台余额
/api/stats 现在返回 platformBalance
UI 的 Stats 面板新增 Platform Balance
2) 交易确认回执（tx confirmations）
新增 /api/tx/status?txId=...
UI 的转账、发布胶囊、购买胶囊会显示确认数
后端返回 txReceipts（包含确认数）
3) 发布/购买自动等待同步完成
新增 waitForPlatformAccount() 和 waitForTxConfirmations()
发布胶囊/购买胶囊/发布任务会等待主节点确认（默认最多 8 秒）
新增：任务发布费（可选）
支持环境变量：

OPENCLAW_TASK_PUBLISH_FEE
默认 0。如果设置为 >0，将在发布任务时扣除并打给平台账户。

你需要做的
安装依赖（之前加了 SQLite）：
npm install
重启节点（确保同步完成）：
./src/cli.js start --config ~/genesis.json --port 4000
./src/cli.js start --config ~/mesh2.json --bootstrap localhost:4000
发布胶囊 / 购买 / 转账测试
UI 中会显示确认数、平台余额。

New config knobs (server-side)
In index.js:

txConfirmations: {
  transfer: 1,
  capsulePublish: 1,
  capsulePurchase: 1,
  taskPublish: 1,
  taskEscrow: 1
},
txTimeoutMs: {
  transfer: 8000,
  capsulePublish: 8000,
  capsulePurchase: 8000,
  taskPublish: 8000,
  taskEscrow: 8000
}

评分系统 + UI 点赞/规则显示 + 接单限制逻辑。要点如下：

完成内容

评分系统（EWMA + 任务加分 + 失败扣分 + 点赞）

EWMA 按任务完成耗时映射 0–10000
每完成任务 +2 分
失败任务 -10 分
点赞 +1 分（每个任务仅一次）
少于 10 个任务不淘汰
分数 < 10 不允许接单，但仍可连网/发任务/发胶囊
接单逻辑

自动投标前检查评分
选标时过滤低分节点
Dashboard 显示

Stats 中显示评分、规则
Task 列表新增 “Like” 列，完成任务可以点赞（一次）