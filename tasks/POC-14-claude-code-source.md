# POC-14 Claude Code JSONL 数据源

> 状态：已完成。以本机 `claude-kimi` 对应的 Claude Code 2.1.220 为验证版本。

## 执行项

- [x] 用固定 session ID 生成两轮真实 Claude Code 会话并确认原文件追加；
- [x] 确认当前 JSONL 目录、会话 ID、版本和顶层类型结构；
- [x] 按文件名与行内 `sessionId` 双重校验精确定位 JSONL；
- [x] 支持独立的 Claude Code projects 根目录；
- [x] 复用 Run 边界、完整行切块、游标、pending upload 和续传；
- [x] 上传元数据标记 `claude_code_jsonl` / `claude_code` / `2.1.220`；
- [x] 最小解析器识别当前稳定顶层类型，不保留正文；
- [x] 验证 Codex 和 Claude Code 数据源不会串流；
- [x] 完成真实 Claude Code → Collector → HTTP → Raw Store → Parser → Query E2E；
- [x] `finish` 后恢复同一 Claude 会话，确认边界外内容不上传。

详细结构与真实 E2E 证据见 [Claude Code JSONL 数据源](../docs/claude-code-source.md)。2026-09-01 类型检查和 34/34 自动化测试通过。
