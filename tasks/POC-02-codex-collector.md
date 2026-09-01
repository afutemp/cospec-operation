# POC-02：Codex Collector

> 状态：已完成（2026-08-31）。依赖 `POC-01/01A` 已冻结。

## 实施项

- [x] 初始化 TypeScript Collector CLI 与测试工程；
- [x] 使用 Node.js `node:net` 实现跨平台 IPC：Linux 抽象 Unix domain socket、Windows Named Pipe；完成用户级单例、健康检查和安全退出，不创建锁文件或 PID 文件；
- [x] 实现 `ensure`、`finish`、`status`、`scan` 命令；
- [x] 从 `CODEX_SESSION_ID` 接收会话 ID，并以 `session_meta.payload.id` 定位和复核 JSONL；
- [x] 实现 Run Binding 的 `pending/open/终态` 状态转换与幂等；
- [x] 使用可查看的 JSON 文件原子保存本地文件身份、generation、confirmed offset、hash 链、待确认上传和 Run 关联，用户侧不使用 SQLite；
- [x] 实现完整行切块、大小限制、hash 与 metadata 生成；
- [x] 实现失败不推进游标、进程重启续传、截断和轮转处理；
- [x] 使用 Node.js 跨平台 API 实现状态目录、后台进程、路径规范化与文件身份识别，仅为确有差异的入口增加小型辅助函数；
- [x] 使用模拟接收端完成 Collector 侧协议测试；
- [x] 提供稳定命令接口和手动验证说明，为后续 `cospec-router` 集成保留接口。

## 验收

- [x] 并发或重复调用 `ensure` 只存在一个用户级 daemon；
- [x] 已存在和尚未出现的 JSONL 都能按 Session ID 正确关联，不使用最新文件猜测；
- [x] 同一 Session 可登记多个 Cospec Run，并得到各自的完整行 offset 边界；
- [x] 重复 `ensure/finish` 幂等，冲突请求明确失败；
- [x] 未完成末行不上传，追加后形成连续区间；
- [x] 上传失败或进程退出不提前推进 confirmed offset，并复用原 `upload_id`；
- [x] 重启、截断和轮转测试通过；
- [x] 生成的上传 metadata 与 Run Binding 均通过冻结 Schema 校验。
- [x] Run 首块从 `ensure` 边界开始，不上传此前历史内容；
- [x] `finish` 补传至结束边界，之后新增的普通对话不再上传。

## 边界

本卡实现 Collector 命令和手动验证，不修改已安装的 `cospec-router`。Router 自动集成在 CLI 接口通过验收后另行执行。

Windows 代码路径已实现，但 Windows 实机验证按项目决定移至最终端到端验收，不作为本卡退出条件。POC-02 的模拟接收端测试属于 Collector 集成测试，不计为完整 E2E。
