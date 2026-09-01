# Cospec Telemetry Pipeline

Cospec 原始遥测数据端到端链路 PoC。

当前目标不是冻结全部采集 Schema 或建设完整运营指标，而是先跑通一条可以演进和重放的链路：

```text
发现持续增长的 JSONL 文件
  → 按完整 JSON 行增量切块
  → 上传与幂等接收
  → 保存不可变原始文件
  → 版本化最小解析
  → 重放
  → 查询与内部视图
```

## 当前范围

- 第一数据源：Codex 会话 JSONL；
- 当前已实现数据源：Codex 会话 JSONL；Claude Code 留待后续；
- 随包信息：JSONL 文件上传元数据和运行环境快照；
- 第一版即支持 offset 游标、增量块、失败续传、截断和轮转诊断；
- 第一版解析：JSON 行合法性、记录类型、时间范围和诊断；
- 当前提供 Run 级重放和只读查询 API。

## 当前不做

- 正式的操作系统服务安装和生产调度；
- artifact manifest、产物元数据和产物正文；
- Query Adapter 和 Evaluator；
- Skill 等业务关联（当前只关联 Cospec Run 与 Agent Session）；
- 完整指标和正式 Dashboard；
- 正式环境部署。

## 文档入口

- [范围与边界](docs/scope.md)
- [首条端到端切片](docs/e2e-slice.md)
- [背景与已确认事实](docs/context.md)
- [当前有效决策](docs/decisions.md)
- [PoC 架构](docs/architecture.md)
- [PoC 技术栈](docs/technology.md)
- [JSONL 增量上传协议 0.1.0](docs/upload-protocol-v0.1.md)
- [Collector 生命周期与 Cospec Run 关联协议 0.1.0](docs/collector-lifecycle-v0.1.md)
- [Collector CLI 手动验证](docs/collector-cli.md)
- [HTTP 上传与接收](docs/http-ingest.md)
- [服务端持久存储](docs/durable-storage.md)
- [Codex JSONL 最小解析器](docs/minimal-parser.md)
- [Run 级解析重放](docs/run-replay.md)
- [只读查询 API](docs/query-api.md)
- [Linux 真实端到端验收记录](docs/e2e-linux-2026-09-01.md)
- [集成前运行与冒烟检查](docs/integration-readiness.md)
- [验收场景](docs/acceptance.md)
- [任务索引](tasks/INDEX.md)
- [历史方案与验证材料](../operation-platform/tasks/INDEX.md)

## 仓库结构

```text
cospec-telemetry-pipeline/
├── README.md
├── docs/       # 当前有效的范围、协议和设计决策
├── tasks/      # 当前 PoC 执行卡
├── collector/  # 本地 Run 关联、JSONL 发现、增量切块和续传
├── server/     # 接收、保存、解析和查询
├── web/        # 当前保留；PoC 不实现页面
└── fixtures/   # 经授权且脱敏的测试夹具
```
