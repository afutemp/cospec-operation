# JSONL 增量上传协议 0.1.0

> 状态：2026-08-31 已冻结。对应 Schema 位于 `contracts/`。

## 请求

```http
POST /api/v1/jsonl-chunks
Content-Type: multipart/form-data

metadata = JSON
source   = 原始 JSONL 字节块
```

## `metadata`

```json
{
  "schema_version": "0.1.0",
  "upload_id": "UUID v4",
  "cospec_run_id": "UUID v4",
  "source_type": "codex_jsonl",
  "source_version": "codex-cli-version-or-unknown",
  "agent_session_id": "Codex session_meta.payload.id",
  "collected_at": "RFC3339 timestamp",
  "collector_version": "collector version",
  "session": {
    "role": "main",
    "root_agent_session_id": "agent-session-id",
    "parent_agent_session_id": null
  },
  "file": {
    "source_file_id": "collector-local stable UUID",
    "generation": 1,
    "path_hint": "redacted path hint",
    "start_offset": 0,
    "end_offset": 1048576,
    "byte_count": 1048576,
    "line_count": 123,
    "sha256": "chunk hex digest",
    "previous_chunk_sha256": null,
    "ends_with_newline": true
  },
  "environment": {
    "captured_at": "RFC3339 timestamp",
    "agent_type": "codex",
    "agent_version": "version-or-unknown",
    "os_platform": "linux|darwin|win32",
    "os_arch": "architecture",
    "cospec_plugin_version": "version-or-unknown",
    "timezone": "IANA timezone-or-UTC"
  }
}
```

`session` 是 2026-09-01 增加的向后兼容可选对象。新版 Collector 对主会话和显式关联的子代理都会写入；旧包缺失时，服务端不得猜测主子关系。子代理使用自己的 `agent_session_id`，并通过 `root_agent_session_id`、`parent_agent_session_id` 归属到顶层会话和直接父会话。用于本地匹配的任务路径不会上传。

## 连续性规则

- offset 采用原始文件 byte offset，区间为 `[start_offset, end_offset)`；
- `byte_count` 必须等于 `end_offset - start_offset`；
- 数据块必须以换行结束，不能上传文件末尾尚未完成的行；
- 连续性的作用域为 `cospec_run_id + source_file_id + generation`；
- 每个 Run 的首块从该 Run 已登记的 `start_offset` 开始，不要求从原始文件0开始；
- 同一 Run 的后一块 `start_offset` 必须等于服务端已确认的 `next_offset`；
- `previous_chunk_sha256` 必须匹配同 generation 上一已确认块；
- 不允许 offset 空洞；完全相同区间和 hash 的重试按幂等成功处理；
- 区间重叠但 hash 或边界不一致时返回冲突，不自动覆盖。

`agent_session_id` 来自 Agent 自身的稳定会话标识。Codex 使用
`CODEX_SESSION_ID`，并以 JSONL 首条 `session_meta.payload.id` 复核；不得用“最新文件”推测会话归属。

## 成功响应

```json
{
  "upload_id": "UUID v4",
  "source_file_id": "UUID",
  "generation": 1,
  "accepted_start_offset": 0,
  "accepted_end_offset": 1048576,
  "next_offset": 1048576,
  "status": "accepted"
}
```

Collector 只在收到并验证成功响应后推进本地 `confirmed_offset`。`finish` 固定 Run 的
`end_offset`；Collector 补传至该位置后停止采集该 Run，之后的 JSONL 内容不属于该 Run。

## 本地状态

Collector 首次启动时在用户级状态目录创建独立的 `installation.json`，其中只保存随机生成的 `anonymous_terminal_id` 和创建时间。该文件不位于插件或 Collector 版本目录，因此正常升级不会改变 ID。删除本地状态、换操作系统用户、重装系统或文件损坏后会生成新 ID；它表示一个用户级 Collector 安装，不宣称是永久物理设备标识。

终端 ID 使用 Node.js `crypto.randomUUID()` 生成，不读取或散列机器名、MAC 地址、磁盘序列号等设备指纹。每个新上传块在 `environment.anonymous_terminal_id` 中携带该值；字段保持可选，以兼容已经存在的旧 Collector 和旧原始块。

```json
{
  "files": {
    "<local-only canonical path>": {
      "source_file_id": "UUID",
      "generation": 1,
      "confirmed_offset": 1048576,
      "previous_chunk_sha256": "hex",
      "observed_file_identity": "platform-specific local value"
    }
  }
}
```

绝对路径和平台文件身份只保存在 Collector 本地，不上传。

## 切块规则

- 目标块大小：5 MiB；
- 块边界只能落在换行符之后；
- 单行上限：10 MiB，超过后停止该文件并报告 `line_too_large`；
- 单块最大：10 MiB；
- 暂不压缩，hash 针对实际上传的原始字节。

边界算法：从 `confirmed_offset` 最多读取10 MiB；优先选择不超过5 MiB的最后一个换行作为块尾。如果前5 MiB没有换行，则继续查找到10 MiB内的第一个换行；仍未找到则报告 `line_too_large`。

## 截断与轮转

- 当前文件大小小于 `confirmed_offset`：generation 加1、offset 从0开始，诊断为 `source_truncated`；
- 同路径的平台文件身份变化：generation 加1，诊断为 `source_rotated`；
- 服务端按 `source_file_id + generation` 保存独立逻辑流；
- 不删除或覆盖旧 generation。

## 错误码

- `source_unreadable`
- `source_changed_during_read`
- `line_too_large`
- `chunk_too_large`
- `offset_gap`
- `offset_conflict`
- `previous_hash_mismatch`
- `hash_mismatch`
- `unsupported_source_version`

## 已冻结的 PoC 约束

- 第一版同时支持 Linux 和 Windows；文件身份优先使用 Node.js 文件状态信息并通过两平台轮转测试验证，该值不上传；
- 未识别的 `source_version` 允许保存原始块，解析状态记为 `unsupported`；
- 测试环境使用独立 Bearer Token，通过环境变量配置，凭据不得写入 metadata 或日志；
- 单块最大10 MiB，服务端 multipart 请求上限12 MiB；
- 单次上传超时120秒；失败采用相同 `upload_id` 和相同 offset 区间重试；
- 正式服务管理、退避周期和生产环境部署不属于 POC-01；PoC 通过手动命令
  验证用户级 Collector 单例拉起与健康检查，暂不修改 `cospec-router`。
