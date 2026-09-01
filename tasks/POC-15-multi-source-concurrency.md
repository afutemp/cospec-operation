# POC-15 双数据源并行验收与调用契约冻结

> 状态：已完成。不修改 `cospec-router`。

## 已确认边界

- 一个 `cospec_run_id` 只绑定一个 Agent Session 和一个 JSONL 来源；
- 同一 Collector 可以同时管理多个独立 Run；
- 不同 Run 可以分别来自 Codex 和 Claude Code；
- 同一 Agent Session 同一时间只允许一个活动 Run；
- 当前不支持单个 Run 聚合多个 Agent Session。

## 执行项

- [x] 同一 daemon 同时关联 Codex Run 与 Claude Code Run；
- [x] 两个来源分别维护 file identity、offset、pending upload 和 hash 链；
- [x] 一个来源上传失败时，另一个来源仍可在同一扫描周期上传；
- [x] 失败来源游标不推进，成功来源游标正常推进；
- [x] 两个 Run 分别完成后不采集结束边界外内容；
- [x] Server 查询正确区分 source type、版本和类型分布；
- [x] Collector 重启后保留两个 Run 的独立状态；
- [x] 冻结 Router 未来使用的 CLI 请求、响应和错误边界；
- [x] 重新验证 npm 安装包包含双数据源运行代码且不包含测试数据。

验收证据见 [双数据源并行验收](../docs/multi-source-acceptance.md)，冻结调用面见 [Collector 调用契约 0.1](../docs/collector-integration-contract-v0.1.md)。
