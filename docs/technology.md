# PoC 技术栈

> 状态：2026-08-31 已确认。

- 语言：TypeScript；
- Collector：Node.js CLI；
- Collector 运行平台：Linux 与 Windows 同等支持；
- Server：Fastify；
- 服务端元数据：SQLite；
- Collector 本地状态：可查看的 JSON 文件，不使用 SQLite；
- Collector 本地通信：Node.js `node:net`，Linux abstract socket / Windows Named Pipe；
- 原始数据块：本地文件系统，通过存储接口隔离；
- 解析任务：服务端进程内任务；
- 测试：Node.js test runner；
- Web：到 POC-07 再根据真实交互决定，不在当前初始化前端工程。

PoC 不引入 PostgreSQL、对象存储、Redis、消息队列或前端框架。替换这些实现时不得改变已冻结的上传协议语义。

Collector 优先直接使用 Node.js 的跨平台 API，共用一套实现。IPC 不使用 TCP 或第三方库，只有 `node:net` 的 endpoint 字符串按平台生成。状态目录及经测试确认存在差异的行为收敛为少量辅助函数，不建立独立的平台适配层。
