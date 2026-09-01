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

Codex 的 `exec_command` 内层结果通常具有 `exit_code`，但通过外层 `functions.exec` 编排时，调用代码可能只返回 `result.output`，使退出码不进入会话 JSONL。该信息无法在服务端补推。因此 Codex 工具状态属于**部分可得**，明确失败数只能作为实际失败数的下界，不能直接作为核心运营 KPI。

不保存消息正文、thinking、工具参数、工具输出或错误正文。

## Run 事实查询

```http
GET /api/v1/runs/:runId/facts
Authorization: Bearer <token>
```

返回活动解析器版本下的消息角色分布、Token 分类及有效样本、模型 observation、工具结果及按工具分布，以及首末消息/工具时间。时间跨度固定标记为 `host_record_span`，Skill 归属固定为 `unavailable`。

查询同时返回：

- `determined_results = successes + failures`；
- `unknown_results = calls - determined_results`，包含显式 unknown 和没有可关联结果的调用；
- `status_coverage = determined_results / calls`，无调用时为 `null`。

工具耗时不依赖成功/失败字段，只要同一 `call_id` 的调用和结果都有合法时间即可计算。`duration` 返回：

- `measured_calls`：能够算出耗时的调用数；
- `unknown_calls`：缺少调用时间、结果时间或结果记录的调用数；
- `invalid_intervals`：结果时间早于调用时间的异常记录数；
- `coverage`：可计算耗时的调用占全部调用的比例；
- `accumulated_ms`：每次工具耗时相加，表示工具使用量；
- `wall_clock_ms`：重叠执行只算一次，表示 Run 实际有多长时间处于工具执行中；
- `p50_ms` / `p90_ms`：一半/九成工具调用可在该时长内返回。

按工具名称的 `byTool` 使用同一口径。该时长是宿主记录的“发起调用到记录结果”时间，不宣称是工具内部纯执行时间。

若展示可判定样本内的失败占比，分母只能使用 `determined_results`，并且必须同时展示 `status_coverage`。覆盖率不足或跨版本不稳定时，不发布统一“工具成功率/失败率”；`failures` 只能命名为“明确失败次数（下界）”。

## 当前限制

- 尚未生成匿名终端 ID，因此不能完成 #2 的终端去重；
- 新版上传可汇总 Run 内主会话和显式关联的子代理；旧上传没有 `session` 元数据时仍不能事后补推子代理覆盖；
- 没有 Stage/Skill 边界，因此不生成 Skill 资源指标；
- 没有用户确认事件，因此不计算用户等待时长；
- 模型分布来自具有 usage 的记录，不代表每条消息都有模型字段。
- Codex 是否保留 `exit_code` 受外层工具编排方式影响，不同会话之间的状态覆盖率不可假定一致。

## 真实样本只读验证

2026-09-01 使用此前授权的样本做结构化离线验证，只输出计数：

- Codex 0.150.1：1,451 行、178 条消息、198 个 Token observation、169 个工具调用和 169 个结果；指定样本的结果均缺少可识别的结构化 `exit_code`，因此 169 个全部保持 unknown，未误判为成功；
- 补充扫描本机 Codex sessions：41 个文件共发现 218 条结构化退出码，其中 171 条为 0、47 条为非零；它们位于 `custom_tool_call_output.payload.output[].text` 的二次 JSON 中。该结果证明退出码部分可得，也证明单一会话的覆盖率不能代表整体；
- Claude Code 2.1.220：2,375 行、1,354 条消息、835 个 Token observation、433 个工具调用和 433 个结果；结果为 98 success、12 failure、323 unknown，与原验证报告中 110 个显式 `is_error`、其中 12 个 true 完全一致；
- 工具耗时核对：Codex 样本 169/169 次、Claude Code 样本 433/433 次均能按调用 ID 和时间配对；Codex 累计/实际经过时间均为 723,304 ms，Claude Code 累计为 2,528,696 ms、去除并发重叠后为 2,515,745 ms；
- 两个宿主的调用/结果数量均一一对应；验证过程未输出或复制正文、工具参数和工具结果；
- 自动化测试另验证了调用与结果跨原始块时，仍能在 Run 查询中按 call ID 形成正确的按工具失败统计。
