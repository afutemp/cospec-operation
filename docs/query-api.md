# 只读查询 API（POC-07）

所有接口使用与上传端相同的 Bearer 鉴权。

## Run 列表

```http
GET /api/v1/runs?limit=20&offset=0
```

`limit` 范围为1至100。返回 Run、Agent Session、数据源、块数、字节数、offset 范围、接收时间和 active parser version。

## Run 详情

```http
GET /api/v1/runs/:runId
```

返回上传汇总、解析状态数量，以及当前 active parser version 对应的总行数、合法/非法/未知行数、类型分布和时间范围。非 active 版本不会混入汇总。

## 原始块状态

```http
GET /api/v1/runs/:runId/chunks
```

返回 upload ID、generation、offset、字节数、SHA-256、解析状态、接收时间和 `rawPresent`。不返回原始文件路径或内容。

## 重放历史

```http
GET /api/v1/runs/:runId/replays
```

返回任务 ID、目标版本、状态、块计数、失败码和起止时间。接口只读，不提供重放触发。

## 宿主资源与工具事实

```http
GET /api/v1/runs/:runId/facts
```

返回活动解析器版本的消息、Token、工具调用/结果和宿主记录时间跨度。工具状态包含明确成功、明确失败、不可判定、可判定数量和 `status_coverage`；明确失败是下界，不能脱离覆盖率解释。工具耗时包含可计算数量、覆盖率、通常耗时、累计使用量和去除并发重叠后的实际经过时间。字段与指标边界见 [宿主资源与工具事实 0.2](host-resource-facts-v0.2.md)。

新版 Collector 上传子代理关联后，响应中的 `subagents` 还会返回子代理数量、已解析数量、最大层级、消息、Token、工具和模型汇总，以及不含正文和任务名的父子会话列表。详细规则见 [Codex 与 Claude Code 子代理采集](subagent-collection.md)。

## 数据边界

API 不返回消息正文、工具参数、工具输出、原始 JSONL、`path_hint` 或服务端绝对路径。本阶段不提供 HTML 页面；使用接口测试、curl 或其他 HTTP 客户端验证。

## Run 使用与资源汇总

```http
GET /api/v1/summaries/run-usage
GET /api/v1/summaries/run-usage?from=2026-09-01T00:00:00Z&to=2026-09-01T23:59:59Z&agentType=codex
```

可选筛选条件为 `from`、`to`、`agentType`、`agentVersion` 和 `model`。接口返回：

- Run 总数，以及按 Agent、Agent 版本和日期的分布；
- 用户/Agent 消息数量；
- 输入、输出、缓存读取、缓存写入、推理输出和宿主报告总量等 Token；
- 按模型统计的 Run 数、记录数和 Token；
- 消息、Token、模型分别有多少 Run 有数据、多少 Run 缺数据。

时间筛选优先使用 JSONL 的首次事件时间；没有事件时间时使用服务端首次收到该 Run 数据的时间，响应中的 `timeSemantics` 固定说明该规则。消息只表示记录数量，不称为对话轮次。Token 平均值只除以该字段真实存在的 Run 数，缺失值不当作零；每种 Token 的有效 Run 数在 `field_run_coverage` 中单独返回。

`resourceDistribution` 给出一次 Run 的资源分布，整体以及按 Agent、Agent 版本、模型分别返回：

- `run_span_ms`：JSONL 第一条到最后一条有效时间记录之间的跨度；
- `messages_per_run`：消息记录数；
- `input_tokens_per_run` / `output_tokens_per_run`：输入和输出 Token，二者不自行合成“总 Token”；
- `tool_calls_per_run`：工具调用数；
- `tool_wall_clock_ms_per_run`：合并并发重叠后的工具经过时间。

每项包含有数据/缺数据的 Run 数、覆盖率、平均值、P50 和 P90。P50 表示约一半 Run 不超过该值，P90 表示约九成 Run 不超过该值。`run_span_ms` 包含用户停顿和其他空闲时间，只表示宿主记录跨度，不等于纯执行耗时。一个 Run 使用多个模型时，会进入每个相关模型分组，因此模型分组之间不可相加为总 Run 数。
