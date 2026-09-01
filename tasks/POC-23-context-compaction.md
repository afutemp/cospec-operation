# POC-23 上下文压缩与上限事实

## 目标

从宿主明确提供的数据中统计 Run 内上下文压缩次数，并在确有字段时记录上下文上限。

## 验收项

- [x] Codex `type=compacted` 计为一次压缩，不推断手动或自动；
- [x] Claude Code `system/compact_boundary` 计为一次压缩，按 `compactMetadata.trigger` 区分 `auto`、`manual` 和未知；
- [x] Claude Code 的 `isCompactSummary=true` 不重复计数；
- [x] 保存 Claude Code 压缩前后 Token 数是否可得，但不保存摘要正文；
- [x] Codex 只从 JSONL 的 `model_context_window` 明确字段记录上下文上限；
- [x] Claude Code JSONL 没有上限字段时返回不可得，不按模型名称猜测；
- [x] Run 事实接口返回压缩总数、触发方式分布和上下文上限可得性；
- [x] 自动化测试覆盖 Codex、Claude Code 和重复计数边界；
- [ ] Claude Code 状态行 `context_window.context_window_size` 的采集通道（不属于原始 JSONL 解析，后续单独接入）。

## 查询口径

`GET /api/v1/runs/:runId/facts` 的 `context` 字段返回压缩总数、自动/手动/未知次数、有压缩前后 Token 数的记录数，以及最后一次明确的上下文上限。Claude Code 官方状态行会给出实时上限，但它不在会话 JSONL 中；接入前 Claude Code 上限必须保持不可得。
