# PoC 架构

## 组件

```text
┌─────────────────┐
│ Local Collector │
│ discover/package│
└────────┬────────┘
         │ upload package
         ▼
┌─────────────────┐
│ Ingest API      │
│ validate/idempot│
└────────┬────────┘
         ▼
┌─────────────────┐      ┌─────────────────┐
│ Raw Store       │─────▶│ Parser Worker   │
│ immutable bytes │      │ versioned/replay│
└────────┬────────┘      └────────┬────────┘
         │                         ▼
         │                ┌─────────────────┐
         └───────────────▶│ Metadata Store  │
                          │ status/results  │
                          └────────┬────────┘
                                   ▼
                          ┌─────────────────┐
                          │ Query API / UI  │
                          └─────────────────┘
```

## 边界

### Collector

- 作为用户级单例运行；PoC 先手动执行 `ensure/finish`，后续再由 `cospec-router` 调用；
- 发现持续增长的 JSONL 并维护文件 generation 与已确认 offset；
- 通过 Agent Session ID 精确定位 JSONL，不按修改时间猜测；
- 只采集活动或待收尾 Cospec Run 的 `[start_offset, end_offset]` 区间；没有活动 Run 时不采集该 Session；
- 只切取以换行结束的完整新增区间；
- 计算数据块 SHA-256 和字节数；
- 生成上传信息与环境快照；
- 不解析运营业务含义。

### Cospec Run Binding

- PoC 验证者为每次工作流生成或恢复 `cospec_run_id`，后续由 `cospec-router` 自动完成；
- `ensure` 登记 `cospec_run_id ↔ agent_session_id` 并记录开始边界；
- 工作流正常结束时调用 `finish`，记录结束边界；
- Collector 补传至结束边界后停止该 Run，边界外的普通对话不上传；
- 同一 Agent 会话允许包含多个不重叠的 Cospec Run；异常未结束的 Run 保留为 `open`，后续显式恢复或标记为 `interrupted`。

### Ingest API

- 验证上传包结构、文件大小和 hash；
- 使用 `upload_id`、文件 generation、offset 区间和内容 hash 保证幂等及连续性；
- 先保存原始内容，再登记待解析状态。

### Raw Store

- 保存上传时收到的不可变原始文件；
- 不因解析器升级修改历史内容；
- PoC 可使用本地文件存储，接口保持可替换。

### Parser Worker

- 解析器带独立版本；
- 从 Raw Store 读取，不依赖 Collector 本地文件；
- 产生最小结果和逐行诊断；
- 失败不污染上一版成功结果。

### Query API / UI

- 展示上传、原始保存、解析和重放状态；
- 不展示消息正文、工具参数和工具输出；
- 不实现业务指标。

## 已确认技术栈

- TypeScript、Node.js CLI、Fastify、服务端 SQLite、本地文件存储和进程内解析任务；
- Collector 用户侧只保存可查看的 JSON 状态文件，不部署 SQLite；
- Collector 使用 Node.js 跨平台 API 共用实现；只有 IPC 地址和状态目录等确有差异的入口使用小型平台辅助函数，不引入独立适配层；
- Web 技术栈到 POC-07 再决定。

详见 [technology.md](technology.md) 和 [collector-lifecycle-v0.1.md](collector-lifecycle-v0.1.md)。正式服务管理、默认退避周期和生产部署方式仍不属于当前阶段。
