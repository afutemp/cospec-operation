# Codex 与 Claude Code 子代理采集

## 用户能看到什么

一个 Run 可以同时包含主会话和它在该 Run 内创建的子代理。查询 Run 事实时，`subagents` 返回子代理数量、已解析数量、最大层级、消息、Token、工具调用、工具耗时、模型分布，以及每个子代理的父会话 ID 和资源摘要。

这些数据不包含提示词、消息正文、工具参数、工具输出或任务名称。

## 如何避免串到历史 Run

Collector 不扫描后按时间猜测归属。它先用主会话的 `start_offset/end_offset` 限定本次 Run 新增的 JSONL：

- Codex：从该区间内的 `spawn_agent` 调用结果取得规范任务路径，再与子代理 `session_meta.agent_path` 精确匹配；子代理文件使用 `parent_thread_id` 继续恢复多层父子关系；
- Claude Code：从该区间内的 `toolUseResult.agentId` 取得子代理 ID，再与 `subagents/agent-<id>.jsonl` 的顶层 `agentId` 精确匹配；子代理继续创建代理时按同一 ID 链递归发现。

没有明确标识的文件不关联。连续两个 Run 共用同一主会话时，只采集各自边界内实际创建的子代理。

## 上传方式

主会话和每个子代理使用不同 `source_file_id`、generation、offset 和 hash 链，但共享同一个 `cospec_run_id`。上传 metadata 的可选 `session` 对象记录：

- `role`：main 或 subagent；
- `root_agent_session_id`：顶层主会话；
- `parent_agent_session_id`：直接父会话。

Codex 的任务路径仅在本地发现过程中短暂用于精确匹配，不写入 Collector 状态或上传 metadata。

子代理从文件开头上传，因为它是在 Run 边界内创建的；Run 结束时为每个已发现子代理分别冻结完整行结束位置。失败续传、完整行切块、轮转和幂等规则与主会话一致。

## 当前限制

- 旧上传包没有 `session` 元数据，不能事后把“没有子代理记录”解释为确实没有子代理；
- Claude Code 只有在父文件明确写出 `agentId` 时才建立父子关系；
- 子代理当前只归属 Run，仍不能归属 Skill；
- Windows 仍需在最终端到端阶段实机验证文件发现行为。

## 当前环境验收

2026-09-01 使用本机真实会话做临时隔离验收，未输出正文，临时数据随后删除：

- 同时发现 1 个 Codex 子代理和 7 个 Claude Code 子代理；
- 主会话与子代理共上传 11 个原始块，11 个全部解析完成；
- Codex 子代理汇总得到 8 条消息、10 次工具调用；
- Claude Code 子代理汇总得到 367 条消息、125 次工具调用；
- Collector → HTTP → 原始保存 → 解析 → Run 事实查询完整通过。
