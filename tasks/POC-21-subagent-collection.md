# POC-21 采集并统计 Codex/Claude Code 子代理

## Collector

- [x] 只从 Run 的主会话 offset 区间发现本次新建子代理；
- [x] Codex 使用 `spawn_agent task_name → agent_path → parent_thread_id`；
- [x] Claude Code 使用 `toolUseResult.agentId → 子代理文件 agentId`；
- [x] 支持递归发现多层子代理；
- [x] 主会话与每个子代理独立切块、续传和冻结结束边界；
- [x] 无显式 ID 时不关联。

## 服务端与查询

- [x] 上传 metadata 保存 main/subagent、顶层会话和直接父会话；
- [x] Run 主会话标识不被子代理文件覆盖；
- [x] Run 事实返回子代理数量、层级、消息、Token、模型、工具调用和耗时；
- [x] 不返回消息正文、工具内容或任务名称；
- [x] 重放继续使用原始块中的父子关联。

## 验证

- [x] 自动化测试覆盖 Codex 和 Claude Code 发现、Run 边界、上传 metadata 及服务端汇总；
- [x] 本机真实 Codex/Claude Code 临时端到端验证通过；
- [x] 45/45 项自动化测试通过；
- [ ] Windows 实机验证留到最终端到端阶段。

详细规则与真实验收见 [子代理采集](../docs/subagent-collection.md)。
