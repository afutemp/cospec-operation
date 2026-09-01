# 项目背景与已确认事实

## 为什么单独建设

原运营方案以完整14项指标和 Dashboard 为目标，但宿主 JSONL、Cospec 记录、产物及关联字段仍在变化。当前策略是先证明原始数据能够可靠到达服务端、保存、解析和重放，再逐步完善数据模型。

本仓库不修改 Cospec 产品仓库，也不承诺当前解析字段是最终运营 Schema。

## 已验证的数据源

### Codex JSONL

- 每行可独立解析为 JSON；
- 能读取会话、消息、时间、模型、Token 和工具调用等记录；
- 主会话和子代理存在显式关联字段；
- 工具失败没有适用于所有工具的统一字段；
- 当前 PoC 的第一数据源。

### Claude Code JSONL

- 每行可独立解析为 JSON；
- 能读取会话、消息、Token、工具调用和明确工具错误；
- 主会话可关联子代理文件；
- 部分状态记录没有时间戳；
- Codex 链路完成后作为第二数据源接入。

## 当前不进入 PoC 的来源

- artifact manifest 和产物：规则预计会调整；
- Query Adapter：保存位置、阶段和关联字段不统一；
- Evaluator：格式及关联关系不统一；
- IPD/DMP 人员与部门：涉及凭据、身份和产线业务口径；
- 新增 Run、Stage、Skill 等 Cospec 事件：数据模型稳定后再评估。

## 历史证据

- [Codex JSONL 验证报告](../../operation-platform/tasks/evidence/codex-jsonl-2026-08-27.md)
- [Claude Code JSONL 验证报告](../../operation-platform/tasks/evidence/claude-code-jsonl-2026-08-27.md)
- [M0 原始数据验证](../../operation-platform/tasks/00-原始数据可得性验证.md)
- [M0 指标与退出决策](../../operation-platform/tasks/M0-指标可计算性与退出决策.md)

