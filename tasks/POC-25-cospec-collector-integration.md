# POC-25：将 Collector 集成进 Cospec 工作流

## 目标

用户安装 Cospec 后不再单独安装 Collector。选定工作流时自动创建 Run 并启动或复用 Collector，工作流明确结束时固定 JSONL 采集边界；电脑重启或进程退出后仍可恢复。

## 验收清单

- [x] 大需求、小需求和一次性组合工作流共用同一套 Run 生命周期命令。
- [x] 用户选定工作流后执行 `run-start`，创建 Run ID、manifest 并调用 Collector `ensure`。
- [x] 正常完成、明确失败、用户取消分别执行 `completed`、`failed`、`interrupted` 收口；等待输入不收口。
- [x] Collector 客户端构建为单个 `.mjs` 文件并随 Cospec 插件分发，不包含服务端和 Web。
- [x] 无全局 Collector 命令、无开发覆盖变量时，Cospec 能自动使用内置 Collector。
- [x] Collector 不存在时自动拉起用户级后台进程，已有进程时复用并通过本地 IPC 发送 Run ID。
- [x] Collector 重启后保留所有 `open/pending` Run；新建其他 Run 不会结束旧 Run，各 Run 可用原 ID 分别续跑。
- [x] 只有显式 `run-finish` 才写入业务终态；服务端的“长时间无活动”等判断不改写该终态。
- [x] Cospec 与 Collector 版本解耦，以 daemon 返回的 `protocol_version=1` 判断兼容。
- [x] Cospec 自动向 Collector 提供当前插件版本；未配置时不要求 LLM 传参。
- [x] Linux 使用真实 Codex JSONL 验证 `run-start → ensure → run-finish → status`，确认来源版本、文件边界和终态。
- [x] Linux 使用内置 Collector 打通真实 HTTP 服务端、持久化、自动解析、查询 API 和 Web 详情页。
- [x] Linux 验证停服期间游标不前进并保留待上传块，服务恢复后由后台扫描自动补传。
- [x] Collector 全量自动化测试通过；Cospec 插件全量自动化测试通过。
- [ ] Windows 实机验证内置分发、Named Pipe 单例、重启恢复和真实 JSONL 链路。

## 当前结果

Linux 已完成开发和验收，证据见 [Cospec 集成真实端到端验收](../docs/e2e-cospec-integration-2026-09-02.md)。Windows 保持未勾选，按约定留到后续完整端到端验证，不用当前环境推测通过。
