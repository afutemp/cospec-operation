# Claude Code Skill 时长端到端验证（2026-09-03）

## 结论

- [x] `claude-sangfor` 通过 ACP 启动真实 Claude Code 会话。
- [x] 当前 Cospec 分支通过 `--plugin-dir` 临时加载，没有替换用户全局插件。
- [x] `small-requirement-workflow` 创建 Run，并关联、上传对应 Claude Code JSONL。
- [x] `product-planning-requirement-clarification` 产生可配对的 START/END 标记。
- [x] 后续实现已补齐：解析器 `0.5.1` 可配对 Skill 标记，并将等待用户回复从 Skill 活跃执行时长中剔除；真实数据重放结果见下文。

## 实测记录

- Run ID：`9d55ba5c-27a3-4a1b-9681-300f1002ffbf`
- Agent Session ID：`9d3705b2-f94b-4ec2-807f-e7b21438708c`
- Agent：Claude Code `2.1.220`（`claude-sangfor`）
- Skill：`product-planning-requirement-clarification`
- execution ID：`a083c4d6`
- START JSONL 时间：`2026-09-03T00:29:12.061Z`
- END JSONL 时间：`2026-09-03T00:31:24.777Z`
- 按 JSONL 时间戳人工相减：`132.716 秒`
- 服务端已接收：38 个块、488,760 字节、130 行，非法行 0。

第二个 `user-journey-design` 已产生 START，但 Claude 长时间不再输出；测试进程终止后按 `interrupted` 显式关闭 Skill 和 Run。该不完整执行不得计算成功时长。

## 后续实现

服务端解析器现从工具结果中识别：

```text
[COSPEC:SKILL:START:<skill>:<execution-id>]
[COSPEC:SKILL:END:<skill>:<execution-id>:<status>]
```

按同一 Run、Skill 和 execution ID 配对，使用宿主 JSONL 时间戳计算总历时，并从中扣除 Agent 可见消息到下一条人工输入之间的等待；工具结果、Skill 注入的 `isMeta` 文本和压缩摘要都不算人工输入。只有 START/END 完整配对才生成时长，缺少 END 的执行只记为未正常结束。使用上述真实 Claude JSONL 重放验证：`product-planning-requirement-clarification` 总历时与活跃执行时长均为 `132716ms`，等待用户为 `0ms`；测试流程没有真的停下来等待人回复。`user-journey-design` 保留为未结束且不产生时长。

联调结果：Run `/facts`、周报汇总接口和 Run 详情页均能读取解析结果；浏览器实际展示总历时 `2.2 分钟`、等待用户 `0 ms`、活跃时长 `2.2 分钟`，未完成 Skill 为“未结束”。真实重放还发现并修复了 Claude Code `isMeta` Skill 说明曾被误判为人工输入的问题。
