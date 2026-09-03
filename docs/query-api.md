# 只读查询 API（POC-07）

普通查询使用 `COSPEC_TELEMETRY_BEARER_TOKEN`。配置 `COSPEC_TELEMETRY_ADMIN_TOKEN` 后，管理员 Token 同时具有普通查询权限和原始 JSONL 下载权限；普通 Token 调用原始下载接口返回 `403 admin_required`。

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

## 原始 JSONL 下载

```http
GET /api/v1/runs/:runId/raw-sources
GET /api/v1/runs/:runId/raw-sources/:sourceFileId/:generation/download
```

来源列表只返回主会话／子代理角色、Session ID、代次、块数、字节数和采集时间，不返回路径。下载接口仅接受管理员 Token；服务端按 offset 顺序拼接该 Run、来源文件和代次下已保存的不可变块，并在返回前复验每块 SHA-256。下载结果是 Collector 为该 Run 实际采集的 JSONL 片段，不保证包含客户端会话文件在 Run 边界外的内容。

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

`skills` 返回当前 Run 中由显式 START/END 标记识别的 Skill 执行：执行总数、成功/失败/中断/未结束数量、时长覆盖率、累计活跃时长、P50/P90、等待用户时长、资源归属、按 Skill 汇总及单次执行明细。单次明细中的 `elapsedMs` 是 START 到 END 总历时，`waitingForUserMs` 是其中有明确对话边界的用户回复等待，`durationMs` 是两者相减后的活跃执行时长。`resources.inclusive` 包含嵌套子 Skill，`resources.self` 将事实只归到最内层完整 Skill；按 Skill 汇总使用 `self`，避免父子重复累计。`resourceAttribution.attribution_coverage` 说明具有时间戳的资源事实中有多少落入完整 Skill 区间。Claude Code `tool_result`、`isMeta` Skill 注入文本等机器记录不算用户回复；缺少任一 Skill 边界或时间倒序时不生成时长或强行归属资源。`attribution.skill=explicit_start_end_markers` 表示已经取得显式标记，`unavailable` 表示当前 Run 没有标记。

新版 Collector 上传子代理关联后，响应中的 `subagents` 还会返回子代理数量、已解析数量、最大层级、消息、Token、工具和模型汇总，以及不含正文和任务名的父子会话列表。详细规则见 [Codex 与 Claude Code 子代理采集](subagent-collection.md)。

## 数据边界

普通查询 API 不返回消息正文、工具参数、工具输出、原始 JSONL、`path_hint` 或服务端绝对路径。原始 JSONL 只能通过上述管理员下载接口作为附件取得；页面不提供在线正文预览。

## Run 使用与资源汇总

```http
GET /api/v1/summaries/run-usage
GET /api/v1/summaries/run-usage?from=2026-09-01T00:00:00Z&to=2026-09-01T23:59:59Z&agentType=codex
```

可选筛选条件为 `from`、`to`、`agentType`、`agentVersion`、`model` 和 `cospecPluginVersion`。接口返回：

- Run 总数，以及按 Agent、Agent 版本和日期的分布；
- Skill 执行总数、状态、时长覆盖率、累计活跃时长、等待次数与时长、单次等待 P50/P90、免等待执行比例、等待占总历时比例，以及按 Skill 的相同汇总；
- Skill 区间内的 Token、工具调用、明确失败和子代理；单次执行同时返回 `inclusive`（包含嵌套子 Skill）和 `self`（只归最内层区间），按 Skill 汇总采用 `self` 避免重复；
- 活跃匿名终端数，以及有／无终端 ID 的 Run 数和覆盖率；
- 匿名终端的每终端 Run 数、使用频次分层、活跃天数、持续使用和本期首次观测；持续使用只在传入 `from` 时计算，并且不等同于人员留存；
- Cospec 插件版本对应的 Run 数、活跃匿名终端数和终端字段缺失 Run 数；
- 用户/Agent 消息数量；
- 输入、输出、缓存读取、缓存写入、推理输出和宿主报告总量等 Token；
- 按模型统计的 Run 数、记录数和 Token；
- 消息、Token、模型分别有多少 Run 有数据、多少 Run 缺数据。
- `activity`：24/48 小时没有 JSONL 新活动的 Run 数和最多 20 条下钻记录；这是排查信号，不是工作流失败状态；
- `versionPerformance`：按 Cospec 插件版本和 Agent 版本给出样本 Run、匿名终端、Skill、Token、工具、子代理和上下文压缩的观察性对比。

版本对比必须结合 `sample_runs` 使用。不同版本的任务和终端构成可能不同，接口不表达版本变化与指标变化之间的因果关系。

时间筛选优先使用 JSONL 的首次事件时间；没有事件时间时使用服务端首次收到该 Run 数据的时间，响应中的 `timeSemantics` 固定说明该规则。消息只表示记录数量，不称为对话轮次。Token 平均值只除以该字段真实存在的 Run 数，缺失值不当作零；每种 Token 的有效 Run 数在 `field_run_coverage` 中单独返回。

`resourceDistribution` 给出一次 Run 的资源分布，整体以及按 Agent、Agent 版本、模型分别返回：

- `run_span_ms`：JSONL 第一条到最后一条有效时间记录之间的跨度；
- `messages_per_run`：消息记录数；
- `input_tokens_per_run` / `output_tokens_per_run`：输入和输出 Token，二者不自行合成“总 Token”；
- `tool_calls_per_run`：工具调用数；
- `tool_wall_clock_ms_per_run`：合并并发重叠后的工具经过时间。

每项包含有数据/缺数据的 Run 数、覆盖率、平均值、P50 和 P90。P50 表示约一半 Run 不超过该值，P90 表示约九成 Run 不超过该值。`run_span_ms` 包含用户停顿和其他空闲时间，只表示宿主记录跨度，不等于纯执行耗时。一个 Run 使用多个模型时，会进入每个相关模型分组，因此模型分组之间不可相加为总 Run 数。

### 子代理整体使用情况

同一接口的 `subagents` 字段只统计带新版 `session` 标记的 Run，并返回：

- 使用/未使用子代理的 Run 数和使用比例；
- 每次 Run 的子代理数量、最大层级和子代理记录跨度；
- 子代理消息、输入/输出 Token、工具调用和工具经过时间；
- 子代理资源占整个 Run 对应资源的比例；
- 按 Agent、Agent 版本和子代理模型的相同统计。

每项资源分布包含平均值、P50、P90和覆盖范围。旧格式 Run 不参与分母，只在 `excluded_legacy_runs` 中返回数量。新版 Run 明确没有子代理时按 0 参与统计。整个 Run 对应资源为 0 或字段缺失时，不计算占比，不补成 0。一个 Run 的子代理使用多个模型时会进入每个相关模型组。
