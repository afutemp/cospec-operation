# 宿主资源与工具事实 0.2

## 对应 P0 指标

本事实层只实现既有 P0 指标中已经具有直接数据证据的部分：

- #8 运行问题分布：工具调用总量、工具类型、明确成功/失败和未知结果；
- #12 工作流会话资源：Run JSONL 边界内的消息、Token 和工具调用；
- #2 活跃匿名终端与 Agent 分布：只提供 Agent 类型和宿主版本维度，匿名终端仍不可得；
- #9 执行与用户等待时间：只提供宿主记录首末时间，语义固定为 `host_record_span`；
- #11 重点能力步骤资源：事实保留，但 Skill 归属明确为 `unavailable`。

## 版本化事实表

解析器 0.2.0 新增 `message_facts`、`token_usage_facts`、`tool_call_facts` 和 `tool_result_facts`。

事实主键包含 `upload_id + parser_version + record_index`，工具块另含 `item_index`。调用和结果可以位于不同原始块，使用同一 Run 内的 `call_id` 查询关联。旧解析结果不被覆盖；使用 Run replay 可生成 0.2.0 事实并原子切换活动版本。

## 字段边界

消息事实只保存角色、合法时间和模型。Token 按宿主实际字段分别保存 input、output、cache read、cache write/creation、reasoning output 和宿主明确报告的 total。

字段缺失保存为 `null`，不补零、不自行合成 total。查询同时返回各 Token 分类的 observation count，便于指标展示有效样本。

工具结果状态只使用直接证据：

- Claude Code：`is_error=true/false` 分别为 failure/success，缺失为 unknown；
- Codex：结构化结果存在 `exit_code` 时，非零为 failure、零为 success；不存在则为 unknown；
- 不根据正文中的 error、failed 或业务 status 文本推断失败。

不保存消息正文、thinking、工具参数、工具输出或错误正文。

## Run 事实查询

```http
GET /api/v1/runs/:runId/facts
Authorization: Bearer <token>
```

返回活动解析器版本下的消息角色分布、Token 分类及有效样本、模型 observation、工具结果及按工具分布，以及首末消息/工具时间。时间跨度固定标记为 `host_record_span`，Skill 归属固定为 `unavailable`。

指标层计算工具失败占比时，分母只能使用 `successes + failures`，并同时展示 `unknown_results`；不能把 unknown 计为成功。

## 当前限制

- 尚未生成匿名终端 ID，因此不能完成 #2 的终端去重；
- 主/子代理关系尚未进入本事实表，因此 #12 当前先覆盖直接绑定 Run 的会话片段；
- 没有 Stage/Skill 边界，因此不生成 Skill 资源指标；
- 没有用户确认事件，因此不计算用户等待时长；
- 模型分布来自具有 usage 的记录，不代表每条消息都有模型字段。

## 真实样本只读验证

2026-09-01 使用此前授权的样本做结构化离线验证，只输出计数：

- Codex 0.150.1：1,451 行、178 条消息、198 个 Token observation、169 个工具调用和 169 个结果；指定样本的结果均缺少可识别的结构化 `exit_code`，因此 169 个全部保持 unknown，未误判为成功；
- Claude Code 2.1.220：2,375 行、1,354 条消息、835 个 Token observation、433 个工具调用和 433 个结果；结果为 98 success、12 failure、323 unknown，与原验证报告中 110 个显式 `is_error`、其中 12 个 true 完全一致；
- 两个宿主的调用/结果数量均一一对应；验证过程未输出或复制正文、工具参数和工具结果；
- 自动化测试另验证了调用与结果跨原始块时，仍能在 Run 查询中按 call ID 形成正确的按工具失败统计。
