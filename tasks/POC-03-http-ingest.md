# POC-03：HTTP 上传与幂等接收

> 状态：已完成（2026-09-01）。依赖 POC-02 已完成。

## 实施项

- [x] Collector 使用 `multipart/form-data` 上传 metadata 与原始 JSONL 块；
- [x] Bearer Token 只进入 Authorization header，不进入 metadata 和日志；
- [x] 实现120秒超时、网络错误、4xx/5xx及响应契约校验；
- [x] Fastify 接口验证鉴权、请求大小、metadata Schema、byte count、hash 和换行边界；
- [x] 按 `cospec_run_id + source_file_id + generation` 校验 offset 与 hash 链连续性；
- [x] 相同 upload、相同区间内容重试幂等成功，冲突请求明确拒绝；
- [x] 使用内存仓储完成协议测试，不在本卡声称可靠持久化。

## 验收

- [x] HTTP 成功确认后 Collector 才推进游标；
- [x] 超时、断网、401、4xx、5xx和畸形响应均不推进游标；
- [x] metadata 或内容不匹配时服务端拒绝；
- [x] offset 空洞、重叠冲突及 previous hash 不匹配时服务端拒绝；
- [x] 重复请求不生成第二份逻辑块；
- [x] Token 不出现在状态文件、outbox、错误或测试输出中。

## 边界

本卡的内存仓储只验证协议状态机。POC-04 接入 SQLite 和不可变原始文件存储，并保证落盘成功后才返回 accepted。
