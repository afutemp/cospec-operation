# Collector 状态与本地滚动日志

Collector 提供两层本地诊断信息，两者均位于平台用户状态目录中。

## 当前状态摘要

`state.json` 的 `diagnostics` 字段由 `cospec-telemetry status` 一并返回：

- `lastScanAt`：本次 daemon 最近一次发起扫描的时间；
- `lastSuccessAt`：最近一次确实上传至少一个数据块的时间；
- `consecutiveFailures`：当前连续扫描/上传失败次数，恢复后归零；
- `lastError`：最近错误的时间、阶段、安全错误码以及可用的 Run/File ID；
- `recoveredAt`：最近一次从连续失败恢复的时间。

状态摘要用于程序快速判断当前情况，并在失败、上传成功或恢复时原子落盘。没有数据变化的每秒空扫描不会反复写状态文件；运行中的 `status` 仍返回内存里的最新扫描时间。

## 持续事件日志

日志路径为状态目录下的 `logs/collector.jsonl`。每行是一个独立 JSON 对象，记录：

- daemon 启动和停止；
- Run ensure 和 finish；
- 数据块上传成功；
- 每次后台或手工扫描失败；
- 连续失败后的恢复。

当前日志达到 5 MiB 后轮转，保留 `collector.jsonl.1` 和 `collector.jsonl.2`。日志不记录原始 JSONL 正文、Bearer Token、请求头、工具内容、完整异常堆栈或绝对源文件路径。未知异常统一映射为 `scan_failed`，避免底层错误文本携带敏感路径。

## 常见错误码

| 阶段 | 错误码示例 | 含义 |
|---|---|---|
| upload | `upload_network_error` | 网络连接失败或服务端不可达 |
| upload | `upload_timeout` | 上传请求超时 |
| upload | `upload_http_401`、`upload_http_409` | 服务端明确拒绝 |
| upload | `invalid_upload_response` | 服务端成功响应不符合确认契约 |
| scan | `source_missing` | 已关联源文件暂时不存在 |
| scan | `source_permission_denied` | 无法读取源文件 |
| scan | `source_changed_during_retry` | 待重试区间内容发生变化 |
| scan | `line_too_large` | 单行超过硬限制 |
| scan | `scan_failed` | 已脱敏的其他扫描异常 |
