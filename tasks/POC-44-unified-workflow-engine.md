# POC-44 统一 Cospec 工作流编排与运营边界

- [x] Router 统一承载大需求、小需求和自定义流程的入口交互
- [x] 新增客户端无关的 `cospec-flow` JSON 控制协议
- [x] 大需求和小需求步骤迁移到声明式定义
- [x] 自定义步骤从统一目录多选，并冻结到本次 Run
- [x] Run、阶段、重点 Skill 时长和结束状态由 Flow Engine 统一标记
- [x] 用户主动跳过的 Skill 保留事件用于排查，但不计入调用量、耗时和资源指标
- [x] Codex 回合无提问结束、随后用户仅回复“继续”时，识别为 Agent 提前结束并在 Run 数据诊断展示
- [x] 等待用户时保持 Run 可恢复，不计为完成
- [x] 质量检查支持通过、失败、无法检查三种结果，失败最多修复三轮
- [x] 每个 Skill 动作返回稳定产物合同，Router 不猜产物类型
- [x] 旧大需求／小需求／自定义 Workflow Skill 降为兼容入口
- [x] 同一会话、同一工作目录和同一流程可以恢复，已启动流程冻结定义快照
- [x] 新增状态机、Router 和兼容入口自动测试
- [x] Cospec 全量 Node.js 测试通过
- [ ] 使用真实 Claude Code 跑一条小需求流程验收
- [ ] 使用真实 Codex 跑一条流程验收

## 结论

JSON 只在 Router 与确定性流程引擎之间传递，不展示给产品规划用户。协议不包含 Claude Code 或 Codex 的消息结构、工具调用格式和会话对象；客户端差异只留在“如何展示问题、如何调用 Skill”这一层。

详细设计见 Cospec 仓库 `plugins/cospec/docs/workflow-engine-v1.md`。
