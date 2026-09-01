# POC-08：真实端到端验收

> 状态：当前环境已通过；Windows 实机项待验证。

## 当前环境验收

- [x] 使用真实 Codex Session ID 和 JSONL，不按最新文件猜测；
- [x] `ensure` 之后的新完整行经 Collector multipart HTTP 上传；
- [x] 服务端可靠保存不可变原始块和 SQLite 元数据；
- [x] 服务端自动解析 pending 块并激活解析版本；
- [x] 查询 API 返回 Run、chunk、解析汇总和 active version；
- [x] `finish` 补传至结束边界，之后新增内容不再上传；
- [x] 服务端重启后查询结果和幂等状态仍存在；
- [x] 验收使用的真实原始数据和凭据不进入仓库，完成后清理临时目录。

## Windows 实机验收（暂不阻塞其他项）

- [ ] Windows Named Pipe 单例与 IPC；
- [ ] Windows 后台 Collector 拉起和安全退出；
- [ ] `%LOCALAPPDATA%` 状态保存和重启续传；
- [ ] Windows 路径、文件身份、截断和轮转；
- [ ] Windows Collector 到服务端的完整 E2E。

## 边界

Windows 当前没有可用环境，所有 Windows 项保持未勾选。当前环境验收通过不代表 Windows 已验证。
