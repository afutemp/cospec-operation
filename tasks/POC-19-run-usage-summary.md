# POC-19 汇总 Run 使用与资源数据

## 用户能看到什么

- [x] 一段时间内共有多少次 Run；
- [x] Codex 和 Claude Code 各有多少次；
- [x] 不同 Agent 版本各有多少次；
- [x] 每天的 Run 数量；
- [x] 用户消息和 Agent 消息数量；
- [x] 输入、输出、缓存等 Token 使用量；
- [x] 不同模型涉及的 Run、记录和 Token；
- [x] 每类数据有多少 Run 有值、多少 Run 缺失。

## 口径约束

- [x] Run 数不称为用户数或终端数；
- [x] 消息数不称为对话轮次；
- [x] Token 缺失不补零，各 Token 字段分别报告覆盖范围；
- [x] 同一个 Run 使用多个模型时分别统计，不指定主模型；
- [x] 时间优先采用 JSONL 首次事件，没有时才采用首次接收时间；
- [x] 只使用活动解析器版本的事实，旧版本不重复计数。

## 查询与验证

- [x] 新增 `GET /api/v1/summaries/run-usage`；
- [x] 支持时间、Agent、Agent 版本和模型筛选；
- [x] 验证双 Agent、多模型、缺失数据、筛选、鉴权和非法参数；
- [x] 42/42 项自动化测试和 TypeScript 类型检查通过。

接口说明见 [只读查询 API](../docs/query-api.md)。
