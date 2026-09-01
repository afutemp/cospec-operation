# 当前有效决策

## D-001 整体链路优先

先跑通采集、上传、保存、解析、重放、查询和内部查看，再完善数据字段和运营指标。

## D-002 原始文件与解析结果分离

原始 JSONL 按上传内容不可变保存。解析器单独版本化；解析结果可以删除、替换和从原始文件重建。

## D-003 第一版即支持增量上报

按 byte offset 读取持续增长的 JSONL，只上传换行结束的完整记录。服务端确认成功后才推进本地游标；失败从未确认 offset 继续。文件截断或轮转时创建新的 generation，不覆盖旧数据。

## D-004 首批数据范围

首批只包含：

- Codex JSONL；
- JSONL 文件上传元数据；
- 运行环境快照。

Codex 完成后复用协议接 Claude Code JSONL。产物、Query、Evaluator 和人员数据不顺带纳入。

## D-005 最小解析

只验证 JSON 行合法性、记录类型、明确存在的会话标识、时间范围和错误诊断。不解析业务正文，不猜测 Run、Skill 或其他跨来源关联。

## D-006 第一阶段只用隔离测试环境

真实 JSONL 可能包含敏感正文。第一阶段只使用经授权的测试样本；正式环境上传前重新评审加密、权限、审计、保留和删除。

## D-007 Collector 生命周期

Collector 是用户级常驻单例。PoC 验证时手动调用 `ensure`：未运行则拉起，已运行则复用并登记本次 Run；结束时手动调用 `finish`。同时保留一次性 `scan` 命令用于测试和补采。接口稳定后再由 `cospec-router` 自动调用，本阶段不修改 Router。

## D-008 显式关联，不猜测 JSONL

调用者传递 `cospec_run_id`、Agent 类型和 Agent Session ID。Collector 用 JSONL 内的会话元数据复核并定位文件。同一 Agent Session 中的多次 Cospec Run 通过各自的 offset 区间区分。

## D-009 用户侧轻量状态

Collector 用户侧不使用 SQLite，也不保存单独的锁文件或 PID 文件。游标与 Run 关联使用可查看、原子替换的 JSON 状态文件。Linux 使用抽象 Unix domain socket，Windows 使用 Named Pipe；IPC 端点同时承担本地通信和单例互斥，不创建文件系统 socket。

## D-010 Linux 与 Windows 同等支持

Collector 第一版必须同时支持 Linux 和 Windows。优先依赖 Node.js 跨平台 API，共用完整行切块、游标、协议、Run 关联及进程逻辑；只对 IPC 地址、状态目录等确有差异的值使用小型辅助函数，不预建独立适配层。平台能力仍需分别验收，不能把仅在 Linux 通过视为 POC-02 完成。

## D-011 IPC 使用 Node.js `node:net`

短生命周期 CLI 与常驻 Collector 使用 Node.js 内置 `node:net` 通信。Linux endpoint 为抽象 Unix domain socket，Windows endpoint 为 Named Pipe；除 endpoint 生成外共用服务端、客户端和消息协议。不采用 `child_process.fork()` 的一次性父子 IPC，不监听本机 TCP 端口，也不引入第三方 IPC 库。

## D-012 按 Cospec Run 边界采集

Collector 常驻不等于持续上传整份 Agent 会话。`ensure` 将当时最后一个完整行 offset 记为 Run 起点；只在 Run 活动期间增量采集。`finish` 固定结束 offset，补传至该位置后停止该 Run。Run 之前、Run 之间和 Run 结束后的普通对话不上传。上传连续性按 `cospec_run_id + source_file_id + generation` 计算，Run 首块不要求从原文件 offset 0 开始。本决策覆盖早期“首次从文件头上传”的设想。
