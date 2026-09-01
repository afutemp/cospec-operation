# Claude Code JSONL 数据源

## 当前验证基线

- 启动命令：`claude-kimi`；
- 实际客户端：Claude Code 2.1.220；
- 默认根目录：`~/.claude/projects`；
- 文件布局：`<project-cwd-encoded>/<session-id>.jsonl`；
- 验证日期：2026-09-01。

Collector 不按修改时间猜测最新文件。定位时要求文件名与 session ID 一致，并且采样行中存在相同的顶层 `sessionId`。`source_version` 取带版本记录中的顶层 `version`；当前样本为 `2.1.220`，允许控制记录缺失该字段。

可通过 `CLAUDE_CODE_PROJECTS_ROOT` 覆盖默认根目录。手工命令示例：

```bash
cospec-telemetry ensure \
  --agent claude_code \
  --session-id "<claude-session-uuid>" \
  --run-id "<cospec-run-uuid>"
```

如果调用方提供 `CLAUDE_SESSION_ID`，可省略 `--session-id`。Run 边界、完整行切块、offset、generation、pending upload、HTTP 幂等和续传均与 Codex 共用实现。

## 最小解析

当前识别以下顶层类型：

- `queue-operation`
- `user`
- `assistant`
- `attachment`
- `last-prompt`
- `mode`

解析器只保存行数、类型分布、合法时间范围和无效 JSON 的位置诊断，不保存消息正文、附件内容或模型输出。新类型记为 unknown，不导致原始块保存失败。

## 真实 E2E 结果

使用固定 session ID 创建两轮基线会话，确认同一 JSONL 从 7,777 bytes 追加到 15,655 bytes。随后：

- `ensure` 在 15,655 建立 Run 起点；
- 恢复同一 Claude 会话产生第三轮增量；
- Collector 上传 1 块、7,832 bytes，区间为 `[15655, 23487]`；
- 元数据为 `claude_code_jsonl / claude_code / 2.1.220`；
- 服务端解析 7 行，全部合法、0 unknown；
- 类型分布为 2 个 `queue-operation`、1 个 `user`、1 个 `attachment`、2 个 `assistant`、1 个 `last-prompt`；
- `finish` 将结束边界固定为 23,487；
- 第四轮把本地文件增长到 31,314 bytes，随后手工扫描上传 0 块；
- 查询结果仍保持 1 块、7,832 bytes 和 7 行。

测试使用短提示、禁用工具和临时凭据。专用 Claude 会话、Collector 状态、SQLite 与原始块均不进入仓库。

## 当前限制

- 只对 Claude Code 2.1.220 做当前版本验证，不维护多版本差异矩阵；
- Windows 实机目录和文件行为仍待 Windows E2E；
- Router 自动传入 Claude session ID 不属于本任务。
