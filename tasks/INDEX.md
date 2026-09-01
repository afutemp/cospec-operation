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

`POC-01/01A` 已冻结，`POC-02/03/04/05/06/07/09/10/11/13` 已完成；`POC-08/12` 当前 Linux 环境验收通过，Windows 实机项保持待验证。协议见 [upload-protocol-v0.1.md](../docs/upload-protocol-v0.1.md) 和 [collector-lifecycle-v0.1.md](../docs/collector-lifecycle-v0.1.md)，JSON Schema位于 `contracts/`。任务编号只在本 PoC 仓库内使用，不与历史 `REC/COL/SRV/UI` 任务混用。
