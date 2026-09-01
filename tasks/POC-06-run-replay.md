# POC-06：Run 级解析重放

> 状态：已完成（2026-09-01）。依赖 POC-05 已完成。

## 实施项

- [x] 只允许调用已安装的解析器版本；
- [x] 按 Run 读取全部不可变原始块并复核 hash；
- [x] 新旧版本解析结果并存；
- [x] 全部块成功或 completed_with_errors 后原子切换 active version；
- [x] 任一块 failed 时保留旧 active version；
- [x] 保存重放任务范围、状态、计数和失败码；
- [x] 相同 Run 与目标版本重复请求幂等；
- [x] 提供显式 Run ID 的服务端命令，不默认全量重放。

## 验收

- [x] 成功重放后整个 Run 使用同一新版本；
- [x] 单块失败时整个 Run 不切换；
- [x] completed_with_errors 允许切换；
- [x] 失败任务不自动重试；
- [x] 原始块和旧解析结果不修改、不删除。
