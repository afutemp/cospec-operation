# POC-12 服务端宕机与自动续传 E2E

> 状态：当前 Linux 环境已完成。不修改 `cospec-router`。

## 验收项

- [x] Server 未启动时，Collector 保留同一 pending upload；
- [x] 上传失败期间 confirmed offset 不推进；
- [x] 每次后台重试均更新连续失败次数并写入滚动日志；
- [x] 启动真实 Fastify、SQLite 和原始文件存储后，无需手工 `scan` 即可自动续传；
- [x] 恢复上传复用故障前生成的 `upload_id`；
- [x] 上传成功后清除当前错误、失败计数归零并记录恢复事件；
- [x] Parser Worker 完成恢复块解析，查询 API 返回正确汇总；
- [x] `finish` 后新增的普通会话内容不进入已结束 Run；
- [x] Server 重启后，SQLite、不可变原始块、解析结果和查询结果保持可用；
- [x] Collector 和 Server 均安全关闭，无遗留进程。

详细证据见 [Linux HTTP 故障恢复验收记录](../docs/e2e-http-outage-recovery-2026-09-01.md)。
