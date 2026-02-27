**完成内容**
- 将记忆查询与同步从 fanout gossip 替换为多跳 DHT：加入 DHT 存储、递归查找、回溯响应与可配置参数 [p2p.rs](file:///Users/vector/.openclaw/workspace/openclaw-mesh/src/p2p.rs)
- 记忆发布时写入 DHT 索引（token → 资产列表、capsule → 内容），查询时走 DHT 拉取并回填本地库 [web.rs](file:///Users/vector/.openclaw/workspace/openclaw-mesh/src/web.rs)
- 新增 DHT 可配置项并接入 CLI 初始化与运行配置 [config.rs](file:///Users/vector/.openclaw/workspace/openclaw-mesh/src/config.rs), [main.rs](file:///Users/vector/.openclaw/workspace/openclaw-mesh/src/main.rs)
- 增加 DHT 距离计算辅助函数 [util.rs](file:///Users/vector/.openclaw/workspace/openclaw-mesh/src/util.rs)

**使用方式**
- 初始化时可指定 DHT 参数：
  ```bash
  cargo run -- --config ~/genesis.json init Genesis-Node --genesis --dht-k 8 --dht-alpha 3 --dht-hops 6
  ```
- 启动：
  ```bash
  cargo run -- --config ~/genesis.json start
  ```

**说明**
- 记忆查询 `/api/memory/query` 现在走 DHT：按 query/tags 生成 token → DHT 拉取 asset_id → 拉取 capsule → 本地回填后再执行过滤。
- 记忆发布 `/api/memory/publish` 会把 capsule 与 token 索引写入 DHT，实现多跳可配置同步。

**验证**
- cargo build

如果你要把任务市场或其它消息也改成 DHT（比如任务检索与路由），我可以继续统一改成同一套 DHT 路由策略。