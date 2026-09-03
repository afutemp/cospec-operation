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
| POC-23 | [统计上下文压缩次数与可得的上下文上限](POC-23-context-compaction.md) | 已完成（Claude Code 上限按决策保持不可得） |
| POC-24 | [搭建 Web 运营看板并与服务端联调](POC-24-web-dashboard.md) | 当前环境通过（Windows 待验证） |
| POC-25 | [将 Collector 集成进 Cospec 工作流](POC-25-cospec-collector-integration.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-26 | [增加周度使用深度与 Skill 资源归属](POC-26-adoption-and-skill-resources.md) | 已完成 |
| POC-27 | [增加 Skill 交互、无活动 Run 与版本对比](POC-27-operations-diagnostics.md) | 已完成 |
| POC-28 | [增加工作流类型、终态与阶段进度](POC-28-workflow-lifecycle.md) | 已完成（Windows 待最终验收） |
| POC-29 | [增加人员工号与姓名快照](POC-29-person-identity-snapshot.md) | 已完成（Windows 待最终验收） |
| POC-30 | [接入 IPD proposer_dept 产线快照](POC-30-ipd-proposer-dept.md) | 已完成（Windows 待最终验收） |
| POC-31 | [上传 Cospec manifest 登记的正式产物](POC-31-artifact-upload.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-32 | [重构领导周报与重点 Skill 运营视图](POC-32-weekly-operations-dashboard.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-33 | [增加 Run 下钻与组合过滤](POC-33-run-drilldown-and-filtering.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-34 | [增加运营异常与专项分析](POC-34-operations-investigation.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-35 | [补全同一人员和终端的缺失身份信息](POC-35-identity-backfill.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-36 | [按新版信息架构重做运营概览](POC-36-overview-redesign.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-37 | [匿名终端纳入活跃用户估算](POC-37-estimated-active-users.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-38 | [重做工作流分析并移除旧产品页面](POC-38-workflow-analysis-redesign.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-39 | [建设 SKILL 分析页面](POC-39-skill-analysis.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-40 | [管理员下载原始 JSONL](POC-40-admin-jsonl-download.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-41 | [建设推广使用页面](POC-41-adoption-analysis.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-42 | [临时本地用户管理](POC-42-local-user-management.md) | 当前 Linux 环境通过（Windows 待验证） |
| POC-43 | [上报接口取消 Token](POC-43-tokenless-ingest.md) | 当前 Linux 环境通过（Windows 待验证） |

`POC-01/01A` 已冻结，`POC-02/03/04/05/06/07/09/10/11/13/14/15/16/17/18/19/20/22/23/26/27` 已完成；`POC-08/12/21/24/25/28/29/30/31` 当前 Linux 环境验收通过，Windows 实机项保持待验证。协议见 [upload-protocol-v0.1.md](../docs/upload-protocol-v0.1.md)、[artifact-upload-v0.1.md](../docs/artifact-upload-v0.1.md)、[collector-lifecycle-v0.1.md](../docs/collector-lifecycle-v0.1.md) 和 [Collector 调用契约 0.1](../docs/collector-integration-contract-v0.1.md)。JSON Schema 位于 `contracts/`。
