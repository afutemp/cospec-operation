# 范围与边界

> 生效日期：2026-08-31

## 方向

采集字段和运营指标仍可能快速变化，当前优先验证整体工程链路。上传层保存原始文件，解析层独立版本化；字段变化时升级解析器并重放，不重做上传链路。

## 首批数据

### 原始数据源

- Codex JSONL；
- Codex 链路跑通后接 Claude Code JSONL。

### JSONL 文件上传元数据

这不是独立数据源，只用于解释随包 JSONL 数据块：

- `source_file_id`；
- Agent Session ID；
- 原路径脱敏标识；
- 文件 generation；
- 起止 byte offset；
- 数据块 SHA-256 和字节数；
- 前一块 SHA-256；
- 是否只包含完整换行结束的 JSONL 记录。

### 运行环境快照

- Agent 类型和版本；
- 操作系统和架构；
- Cospec 当前插件版本；
- 采集器版本；
- 时区和快照时间。

### Cospec Run 关联元数据

- Cospec Run ID；
- Agent 类型与 Agent Session ID；
- JSONL 的 `source_file_id`、generation 及开始/结束 offset；
- Run 状态与开始/结束时间。

它只建立 Run 与原始 JSONL 区间的关系，不解析或复制消息正文。

## 安全边界

- 真实 JSONL 可能包含用户消息、Agent 回复、工具参数和输出；第一阶段只允许在隔离测试环境使用经授权样本。
- JWT、Cookie、API token 和其他凭据禁止进入仓库、夹具、报告和日志。
- 正式环境上传、加密、访问权限、审计、保留和删除必须单独评审。
- artifact manifest、产物和人员数据不因通用文件上传能力存在而顺带纳入。

## 历史材料

原运营方案、50项数据验证、指标矩阵及范围调整记录保留在 [`operation-platform`](../../operation-platform/tasks/INDEX.md)。它们是背景和证据，不作为本仓库当前实施任务。
