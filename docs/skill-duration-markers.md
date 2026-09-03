# Skill 执行时长标记方案

> 状态：标记、采集、解析、查询与页面展示已实现  
> 更新日期：2026-09-03

## 1. 要解决的问题

Codex 和 Claude Code 的原始 JSONL 能记录消息、工具调用和 Token，但不能稳定给出 Cospec Skill 从开始执行到完整退出的业务边界。

Claude Code 的 Skill 工具调用耗时只覆盖工具自身的调用边界，不能作为 Skill 后续模型请求、工具调用和子任务的完整执行时长。因此不同时维护 OpenTelemetry、Hook、子代理生命周期等多套 Skill 时长口径。

## 2. 已确定的唯一口径

Cospec 在每次 Skill 执行的开始和结束位置调用标记脚本。脚本向工具结果输出一行结构化短标记；Collector 从 Codex 或 Claude Code JSONL 中解析并配对。

```bash
node "<plugin-root>/scripts/cospec-telemetry.mjs" skill-start tr1-requirements-spec
node "<plugin-root>/scripts/cospec-telemetry.mjs" skill-end tr1-requirements-spec
```

成功输出示例：

```text
[COSPEC:SKILL:START:tr1-requirements-spec:a7f3c921]
[COSPEC:SKILL:END:tr1-requirements-spec:a7f3c921:OK]
```

Skill 总历时为匹配的 END 时间减去 START 时间。正式展示的“活跃执行时长”会进一步扣除其中等待用户回复的时间。Skill 调用量按成功解析的 START 事件计算。

等待用户回复的边界来自同一份原始 JSONL：从 Agent 最后一条可见文字消息开始，到下一条明确的人工输入结束。Claude Code 的 `tool_result`、`isMeta` Skill 注入文本、Codex 的工具调用结果、压缩摘要和内部控制记录都不算人工输入。没有同时观察到这两个边界时，不推测等待时长，也不扣减。

## 3. 为什么保留一行输出

命令输出会进入 JSONL，也会作为工具结果返回给 LLM。成功时只输出一行短标记，避免大段 JSON 或说明文字占用上下文。

不能完全静默：Collector 需要根据实际工具结果确认标记脚本执行成功，不能只看到模型生成了命令就认为事件已经发生。

详细的 `run_id`、Agent Session ID、工作流名称和时间等信息不返回给 LLM，由脚本结合工作区上下文和当前执行状态补齐。

## 4. 参数和执行 ID

LLM 只提供：

- `skill-start` 或 `skill-end`；
- Skill 名称。

脚本负责：

- 从当前工作区上下文取得 `run_id`、Agent Session ID 和工作流；
- 在 START 时生成短执行 ID；
- 保存当前未结束的 Skill 执行状态；
- 在 END 时找到匹配的执行 ID；
- 输出可被 Collector 稳定识别的短标记。

第一版按当前工作流中同名 Skill 串行执行处理。将来需要并行执行同名 Skill 时，再由编排层传入或持有执行 ID，不能依赖 Skill 名称猜测配对。

## 5. 异常口径

- START 成功、END 成功：记录完成状态，并分别计算总历时、等待用户时长和活跃执行时长。
- START 成功、END 标记为失败：记录失败状态并计算截至 END 的时长。
- START 成功、END 标记为中断（`INTERRUPTED`）：记录中断状态并计算截至 END 的时长，不计为成功或失败。
- START 成功、没有匹配 END：记录为“未正常结束”，不计算时长。
- 只有 END：记录为孤立结束事件并进入诊断，不补造 START。
- 标记脚本执行失败：保留简短错误，Collector 不生成成功事件。
- 重复读取同一标记：按 Run、会话、执行 ID 和事件类型幂等去重。

## 6. 数据使用边界

这套标记是 Skill 调用量、成功／失败／未正常结束和执行边界的唯一正式来源；等待用户时间只从边界内明确的对话轮次扣除。

Claude Code OpenTelemetry、Tool Hook 或子代理事件以后可以用于分析模型请求、工具耗时等细节，也可以用于排查，但不能覆盖或替代这里的 Skill 统计口径。

## 7. 后续实现项

- [x] 定义跨 Codex、Claude Code 一致的标记格式（`OK` / `FAILED` / `INTERRUPTED` / `ORPHAN`）和转义限制。
- [x] 实现跨平台 Node.js 标记脚本及工作区上下文读取。
- [x] 在选定的 Cospec 工作流编排位置加入 START/END 调用。
- [x] Collector 解析两类 Agent JSONL 中的成功工具结果标记。
- [x] 服务端保存 Skill 执行事件并实现幂等配对。
- [x] 查询接口提供调用量、状态、完整率及 P50/P90 活跃时长。
- [x] 从活跃时长中剔除有明确边界的用户回复等待，并保留总历时与等待时长。
- [x] 验证正常结束、失败、缺少 END、重复上传、多 Skill 串行和工具结果不被误判为人工回复。
- [ ] 后续出现同名 Skill 并行需求时补充显式执行 ID 传递方案。
