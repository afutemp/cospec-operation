# 双数据源并行验收

## 绑定模型

一个 Cospec Run 只关联一个 Agent Session 和一个 JSONL 来源。同一用户级 Collector daemon 可以同时维护多个独立 Run，包括 Codex Run 和 Claude Code Run。当前不支持一个 Run 聚合多个 Session。

## 自动化验收

同一个 daemon 同时建立 Codex 和 Claude Code Run，并通过真实 Fastify HTTP、SQLite、Raw Store、Parser Worker 和 Query Repository 完成以下验证：

- 两个来源分别从 ensure 时的完整行边界开始；
- Codex 增量标记为 `codex_jsonl / 0.150.1`；
- Claude Code 增量标记为 `claude_code_jsonl / 2.1.220`；
- 两个 Run 各自生成一个连续原始块；
- Parser 分别得到 `event_msg` 和 `assistant` 类型，不串流；
- 两个 Run 分别 finish 后追加普通内容，再次扫描产生 0 个块；
- daemon 使用同一状态目录重启后仍保留两个 completed Run。

## 故障隔离

扫描器按来源顺序处理，但单一来源失败不会终止整个扫描周期：

- 失败来源保留 pending upload 且 confirmed offset 不推进；
- 后续来源仍会上传并推进自己的 confirmed offset；
- 若同一周期部分成功、部分失败，成功进度和 `chunks_uploaded` 日志仍会保存，同时整体诊断保留失败错误；
- 下一后台周期只重试仍处于 pending 的来源。

## 安装包复验

2026-09-01 重新执行 `npm pack` 并在全新临时 npm 项目安装：

- tarball 为 37,702 bytes，共 71 个运行时条目；
- 包含双数据源定位、元数据和解析代码；
- 不包含 `*.test.*`、`tasks/`、`docs/` 或测试遥测数据；
- 安装后的 CLI 对非法 Agent 返回 `{"ok":false,"error":"invalid_option:agent"}` 和退出码 1。

全量类型检查和 37/37 自动化测试通过。
