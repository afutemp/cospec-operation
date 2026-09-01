# Linux HTTP 故障恢复 E2E（2026-09-01）

## 测试范围

使用临时、合成且不含真实会话内容的 Codex 格式 JSONL，验证真实 Collector daemon、原生 HTTP 上传、Fastify、SQLite、不可变原始存储、Parser Worker 和 Query API。测试未修改或调用 `cospec-router`。

## 故障阶段

- Collector 关联 Run 时记录的起始 offset 为 143；
- JSONL 随后增加 2 个完整记录，共 195 bytes；
- Server 端口保持关闭，Collector 连续获得 `upload_network_error`；
- 检查时连续失败次数已达到 11，继续运行期间最终达到 18；
- pending upload 始终使用同一个 upload ID；
- confirmed offset 始终停在 143，未在服务端确认前误推进；
- `collector.jsonl` 为每次失败保留独立、结构化的 `scan_failed` 事件。

## 自动恢复阶段

- 在相同地址启动真实持久化 Server，没有调用手工 `scan`；
- 下一轮后台扫描自动上传原 pending block；
- confirmed offset 从 143 推进到 338，pending upload 清空；
- `consecutiveFailures` 归零，`lastError` 清空并写入 `recoveredAt`；
- 日志依次记录 `scan_recovered` 和 `chunks_uploaded`；
- Server 保存 1 个 195-byte 原始块，Parser 0.1.0 完成解析；
- 查询结果为 2 行合法 JSON，类型分别为 `event_msg` 和 `response_item`，offset 区间为 `[143, 338]`。

## 结束边界与服务端重启

- `finish` 将 Run 的 end offset 固定为 338；
- 随后追加的普通会话记录未生成第二个块；
- Server 安全关闭并使用同一存储目录重启；
- 重启后查询仍返回 1 个块、195 bytes、2 条有效记录，原始块存在；
- 最后安全关闭 Collector 和 Server，未留下相关进程。

## 安全与清理

- 使用仅存在于进程环境中的临时测试 token，未写入仓库；
- 仓库未保存合成 JSONL、SQLite、原始块或 Collector 状态；
- 临时测试目录位于 `/tmp`，不属于项目交付内容。
