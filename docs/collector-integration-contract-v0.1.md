# Collector 调用契约 0.1

> 状态：集成前冻结。未来 `cospec-router` 只依赖本页定义的命令、JSON 响应和退出码。

## Run 绑定边界

- 一个 `cospec_run_id` 只绑定一个 `agent_type + agent_session_id`；
- `agent_type` 仅允许 `codex` 或 `claude_code`；
- 同一 Collector 可并行维护多个不同 Run；
- 同一 Agent Session 同一时间只允许一个 `pending/open` Run；
- 一个 Run 只绑定一个顶层 Session；该 Session 在 Run 边界内通过显式 ID 创建的子代理属于同一 Run，并作为独立 JSONL 来源上传。不支持无显式关联的任意 Session 聚合。

## 开始或恢复

```bash
cospec-telemetry ensure \
  --agent <codex|claude_code> \
  --session-id <agent-session-uuid> \
  --run-id <cospec-run-uuid>
```

调用幂等：相同 Run、Agent 和 Session 重复调用返回同一 binding。相同 Run 改绑其他来源返回 `run_binding_conflict`。`run-id` 在手工使用时可省略并由 CLI 生成；Router 集成必须显式提供。

成功响应为：

```json
{
  "ok": true,
  "data": {
    "schemaVersion": "0.1.0",
    "cospecRunId": "<uuid>",
    "agentType": "codex",
    "agentSessionId": "<uuid>",
    "sourceFileId": "<uuid-or-null>",
    "generation": 1,
    "startOffset": 123,
    "endOffset": null,
    "status": "open"
  }
}
```

若 Session JSONL 尚未出现，返回成功 binding，但状态为 `pending`，文件和 offset 字段为 `null`。daemon 后续按周期尝试解析 pending binding。

## 结束

```bash
cospec-telemetry finish \
  --run-id <cospec-run-uuid> \
  --status <completed|failed|interrupted>
```

`finish` 先记录当前完整 JSON 行结束边界，再立即尝试补传。相同状态重复调用幂等；不同状态重复结束返回 `run_finish_conflict`。结束边界保存后，即使上传暂时失败，后台仍会继续处理该边界内的 pending upload。

## 状态与诊断

```bash
cospec-telemetry status
```

返回完整本地 Run/File 状态和 `diagnostics` 摘要。调用方不得读取或解析 `state.json` 和滚动日志作为控制接口；它们只用于本地诊断。

手工 `scan` 和 `shutdown` 是运维/测试命令，不是 Router 正常工作流所需调用。

## 响应和退出码

- 所有 CLI 结果都向 stdout 输出一个 JSON 对象；
- 成功：`{"ok":true,"data":...}`，退出码 0；
- 失败：`{"ok":false,"error":"stable_error_code"}`，退出码非 0；
- 调用方按 `ok` 和 `error` 判断，不匹配完整文本输出；
- JSONL 正文、token、请求头和堆栈不会进入响应。

参数错误包括：`invalid_option:agent`、`invalid_option:status`、`invalid_option:session-id`、`invalid_option:run-id` 和 `missing --<name>`。生命周期错误包括 `run_binding_conflict`、`session_has_active_run`、`run_not_found`、`run_finish_conflict` 和 `session_file_not_found`。

## daemon 行为

- 任一命令发现 daemon 不存在时会自动拉起用户级单例；
- 后续命令通过本地 IPC 连接同一 daemon；
- daemon 继承首次启动时的 Server URL、token、数据源根目录和扫描周期环境；
- 配置变化后，运维方应执行 `shutdown`，再由下一条命令重新拉起；
- 默认后台扫描周期为 5 分钟，`ensure` 异步安排立即扫描，`finish` 立即扫描。
