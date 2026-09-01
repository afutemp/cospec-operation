# PoC 任务索引

| 编号 | 任务 | 状态 |
|---|---|---|
| POC-01 | 定义 JSONL 增量上传协议 | 已完成 |
| POC-01A | 定义 Collector 生命周期与 Cospec Run 关联协议 | 已完成 |
| POC-02 | [实现 Collector 单例、Codex JSONL 关联、游标、完整行切块与续传](POC-02-codex-collector.md) | 已完成 |
| POC-03 | [实现上传接口与幂等接收](POC-03-http-ingest.md) | 已完成 |
| POC-04 | [保存不可变原始文件与解析状态](POC-04-durable-raw-store.md) | 已完成 |
| POC-05 | [实现 Codex JSONL 最小解析器](POC-05-minimal-parser.md) | 已完成 |
| POC-06 | [实现 Run 级解析重放](POC-06-run-replay.md) | 已完成 |
| POC-07 | [实现只读查询 API](POC-07-query-api.md) | 已完成 |
| POC-08 | [完成真实端到端验收](POC-08-e2e-acceptance.md) | 当前环境通过（Windows 待验证） |
| POC-09 | [固化集成前可运行基线](POC-09-integration-readiness.md) | 已完成 |
| POC-10 | [验证安装包与命令交付](POC-10-package-delivery.md) | 已完成 |
| POC-11 | [补充 Collector 异常状态与滚动日志](POC-11-collector-observability.md) | 已完成 |
| POC-12 | [验证服务端宕机后的自动续传](POC-12-outage-recovery-e2e.md) | 当前 Linux 环境通过 |
| POC-13 | [调整 Collector 默认扫描频率](POC-13-scan-cadence.md) | 已完成 |
| POC-14 | [接入 Claude Code JSONL 数据源](POC-14-claude-code-source.md) | 已完成 |
| POC-15 | [双数据源并行验收与调用契约冻结](POC-15-multi-source-concurrency.md) | 已完成 |
| POC-16 | [为 P0 #2/#8/#9/#12 建设宿主事实层](POC-16-host-resource-facts.md) | 已完成 |
| POC-17 | [收紧工具状态运营口径](POC-17-tool-status-operability.md) | 已完成 |
| POC-18 | [统计工具调用耗时](POC-18-tool-duration.md) | 已完成 |
| POC-19 | [汇总 Run 使用与资源数据](POC-19-run-usage-summary.md) | 已完成 |
| POC-20 | [统计 Run 时长与资源分布](POC-20-run-resource-distribution.md) | 已完成 |
| POC-21 | [采集并统计 Codex/Claude Code 子代理](POC-21-subagent-collection.md) | 当前环境通过（Windows 待验证） |
| POC-22 | [汇总子代理使用与资源分布](POC-22-subagent-usage-summary.md) | 已完成 |

`POC-01/01A` 已冻结，`POC-02/03/04/05/06/07/09/10/11/13/14/15/16/17/18/19/20/22` 已完成；`POC-08/12/21` 当前 Linux 环境验收通过，Windows 实机项保持待验证。协议见 [upload-protocol-v0.1.md](../docs/upload-protocol-v0.1.md)、[collector-lifecycle-v0.1.md](../docs/collector-lifecycle-v0.1.md) 和 [Collector 调用契约 0.1](../docs/collector-integration-contract-v0.1.md)。JSON Schema 位于 `contracts/`。
