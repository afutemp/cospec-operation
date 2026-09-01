# Codex JSONL 最小解析器（POC-05）

## 处理流程

服务端进程每秒检查一次 SQLite `pending` 队列：

1. 读取不可变原始块；
2. 重新计算 SHA-256 并与接收记录比较；
3. 按原始 byte offset 逐行解析 JSON；
4. 保存解析器版本、行数、类型分布、时间范围和诊断；
5. 更新 chunk 解析状态。

## 状态

- `completed`：所有行 JSON 合法；
- `completed_with_errors`：存在非法 JSON 行，其余行仍正常统计；
- `failed`：原始文件丢失、不可读或 hash 不一致。

未知顶层记录类型只计入 `unknown_type_lines`，不视为错误。

## 数据最小化

解析结果不保存消息正文、工具参数、工具输出或非法行内容。非法行诊断只包含行号、块内 byte offset 和 `invalid_json` 错误码。Agent Session ID、Codex 版本和 Run ID沿用上传 metadata，不从正文猜测。

解析结果以 `upload_id + parser_version` 为主键。同一版本重复执行不产生重复记录；后续 POC-06 可使用新版本从原始块重放。
