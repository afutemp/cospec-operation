# POC-28 工作流类型、终态与阶段进度

- [x] 冻结 `run_started`、`stage_started`、`stage_finished`、`run_finished` 四类事件。
- [x] 支持大需求、小需求、自定义三类工作流，并保留具体工作流名称。
- [x] Collector 通过本地 JSON 状态持久保存待发事件，上传失败后随扫描周期重试。
- [x] 服务端幂等接收、持久保存和查询工作流事件。
- [x] Cospec Router 在用户选定工作流后明确传入类型。
- [x] 大需求、小需求、自定义工作流要求上报阶段边界。
- [x] 总览展示类型分布、终态、完成率和阶段漏斗。
- [x] Run 详情展示原始工作流进度事件。
- [x] Linux 自动化测试通过。
- [ ] Windows 随最终端到端验收验证。

## 口径

- “进行中”表示尚未收到明确终态，不根据静默时长擅自改成中断。
- 完成率只使用 `completed / (completed + failed + interrupted)`，运行中不进入分母。
- 阶段由 Cospec 编排显式上报，不从 JSONL 文本或产物目录猜测。
- `event_id` 是幂等键，同一个事件重试不会重复计数。
