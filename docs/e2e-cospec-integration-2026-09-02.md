# Cospec 集成真实端到端验收（Linux，2026-09-02）

## 范围

使用 `cospec` 的 `feat/cospec-telemetry-integration` 分支、插件内置单文件 Collector、临时本地服务端和真实 Codex JSONL 副本，验证从工作流建 Run 到页面展示的完整链路。测试数据和 Token 仅存在 `/tmp`，未调用生产接口。

## 核心证据

- 主 Run：`5c93c35f-dfd5-4773-9efb-41ce493ff499`。
- Cospec `run-start` 返回 `collector=connected`，没有设置外部 Collector 命令或 JS 入口。
- Collector 从真实 Codex 0.150.1 JSONL 的 Run 起点开始上传，服务端最终收到 2 个连续块、213735 bytes、60 行。
- Parser 0.3.0 完成两个块：60 行均为合法 JSON，API 返回消息、Token、工具耗时和上下文上限事实。
- 浏览器实际请求 Run detail、facts、chunks、replays 四个接口，均返回 HTTP 200；页面显示完整 Run ID、Codex 0.150.1、Parser 0.3.0、60 行及 `2 块 · 208.7 KB`。

## 故障恢复

1. 首块确认游标为 `11038926`。
2. 停止服务端后追加 10 个完整 JSONL 记录；Collector 形成固定的 `pendingUpload`，确认游标仍为 `11038926`，诊断为 `upload_network_error`。
3. 服务端恢复后没有执行手工 `scan` 或创建新 Run；300ms 测试扫描周期自动重试成功，确认游标前进到 `11058644`，`pendingUpload` 清空，服务端块数从 1 变为 2，诊断恢复为正常。

## 重启与并行 Run

- Collector 重启后，主 Run 仍为 `open`，原 `startOffset=10844909` 未变化。
- 重启时同时保留其他 Run；测试最终状态为主 Run `open`、第二 Run `open`、无来源 Run `pending`，没有自动写入 `interrupted`。
- 对主 Run 显式执行 Cospec `run-finish --status completed` 后，只有主 Run 变为 `completed` 并固定 `endOffset=11058644`；第二 Run 仍为 `open`，无来源 Run 仍为 `pending`。

## 边界

- Windows 内置分发、Named Pipe 和真实 JSONL 端到端仍未验证。
- 总览默认“本周”按 JSONL 事件时间过滤。本次复用的真实样本事件发生在 2026-08-27，因此总览本周为 0；Run 列表和详情页能正确展示本次接收的数据。这是既定时间语义，不是采集失败。
