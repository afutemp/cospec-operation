# Collector 生命周期与 Cospec Run 关联协议 0.1.0

> 状态：2026-08-31 已冻结。对应 `POC-01A`。

## 角色边界

- PoC 验证者：取得 Agent Session ID，生成或恢复 Cospec Run ID，手动调用生命周期命令；
- Collector CLI：提供 `ensure`、`finish`、`status` 和 `scan`；
- Collector daemon：每用户单例，发现和上传多个会话文件，维护游标与 Run 关联；
- Ingest API：保存原始块和关联记录，不从正文猜测 Run。

## 工作流入口

```bash
cospec-telemetry ensure \
  --agent codex \
  --session-id "$CODEX_SESSION_ID" \
  --run-id "$COSPEC_RUN_ID"
```

`ensure` 必须幂等：

1. 尝试占用当前用户专属的本地 IPC 端点，并执行健康检查；Linux 使用抽象 Unix domain socket，Windows 使用 Named Pipe；
2. daemon 不存在时以脱离当前 Codex 命令生命周期的方式拉起，并等待健康检查成功；若端点已被占用则连接现有 daemon，不再启动第二个进程；
3. 登记或复用 `cospec_run_id ↔ agent_session_id`；
4. 通过 JSONL `session_meta.payload.id` 定位并复核文件，不使用“最新文件”；
5. 将当时已落盘的最后一个完整 JSONL 行末 byte offset 记为 Run 开始边界；
6. 仅在 daemon 健康且关联登记成功后返回成功。

开始边界之前的历史 JSONL 不采集。daemon 常驻期间只扫描存在活动或待收尾 Run 的 Session。

如果 JSONL 尚未出现，关联记为 `pending`；daemon 发现匹配 `session_meta` 后补齐 `source_file_id`、generation 和开始 offset。

## 工作流结束

```bash
cospec-telemetry finish --run-id "$COSPEC_RUN_ID" --status completed
```

`finish` 将当时已落盘的最后一个完整 JSONL 行末 byte offset 记为结束边界，状态允许 `completed` 或 `failed`。重复提交相同结果按幂等成功；冲突结果必须报错，不静默覆盖。

如果 Run 在主会话边界内创建了具有显式关联 ID 的子代理，daemon 会为每个子代理建立独立文件游标，并在 `finish` 时分别冻结其完整行结束位置。子代理不会改变顶层 Run 绑定的 `agent_session_id`。

Collector 在返回 `finish` 前补传截至结束边界的完整行；达到该边界后不再采集此 Run。后续普通对话不会上传，除非新的 `ensure` 建立另一个 Run。

未调用 `finish` 的 Run 保持 `open`。下次路由可使用同一 Run ID 恢复，或者显式以 `interrupted` 结束；不得仅凭超时猜测业务结果。

## 关联记录

```json
{
  "schema_version": "0.1.0",
  "cospec_run_id": "UUID v4",
  "agent_type": "codex",
  "agent_session_id": "01a04249-...",
  "source_file_id": "UUID or null while pending",
  "generation": 1,
  "start_offset": 12000,
  "end_offset": 45000,
  "started_at": "RFC3339 timestamp",
  "ended_at": "RFC3339 timestamp or null",
  "status": "pending|open|completed|failed|interrupted"
}
```

同一 Agent Session 允许多个 Cospec Run。正常情况下 Run 区间不得彼此重叠；普通对话可以位于 Run 区间之外。关联记录不包含消息正文。

## 进程与本地状态

- PoC 第一版同时支持 Linux 和 Windows；
- 单例范围为当前操作系统用户，而不是项目或 Session；
- IPC 使用 Node.js 内置 `node:net`，服务端和客户端逻辑跨平台共用，不引入第三方 IPC 库，也不监听 TCP 端口；
- 只有 endpoint 字符串按平台生成：Linux 使用包含用户 UID 的抽象 Unix domain socket，Windows 使用当前用户专属的 Named Pipe；端点用于本地通信和并发启动互斥，不创建锁文件、PID 文件或文件系统 socket；
- daemon 可同时维护多个 Session 和文件游标；
- 游标、generation 与 Run 关联保存为权限仅当前用户可读写的 JSON 文件，并以同目录临时文件加原子替换方式更新；Linux 使用 `${XDG_STATE_HOME:-~/.local/state}/cospec-telemetry`，Windows 使用 `%LOCALAPPDATA%\\CospecTelemetry`；用户侧不使用 SQLite；
- 后台进程、路径和文件状态优先直接使用 Node.js 跨平台 API；仅在测试证明行为不同时增加局部平台分支。Windows 与 Linux 分别执行单例、重启续传、截断和轮转测试；
- 认证凭据仅通过环境或受限配置读取，不写入关联记录；
- 收到退出信号后不再接收新任务，完成当前块的确定性处理并保存游标后退出；
- `scan` 向常驻 Collector 请求立即执行一轮发现、切块和上传；daemon 自身也按内部周期持续扫描。

## 当前手动验证

- 工作流实质执行前手动调用 `ensure`；
- 将 Run ID 保存在本次验证记录中，不能只依赖临时 shell 变量；
- 工作流正常或失败结束时手动调用 `finish`；
- `ensure` 失败时明确报告遥测未启动，不得伪造关联成功，也不得阻止用户选择继续业务工作流。

`cospec-router` 的自动调用属于后续集成：CLI 接口通过验收前不修改已安装 Router。
