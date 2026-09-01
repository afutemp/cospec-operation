# 服务端持久存储（POC-04）

## 数据目录

服务端默认使用仓库运行目录下的 `storage/`，可通过 `COSPEC_TELEMETRY_STORAGE_DIR` 覆盖：

```text
storage/
├── metadata.sqlite
├── metadata.sqlite-wal
├── metadata.sqlite-shm
└── raw/<run-id>/<source-file-id>/<generation>/<start>-<end>-<sha256>.jsonl
```

运行期目录已被 `.gitignore` 排除。

## 确认顺序

1. 校验 upload ID、offset 和 previous hash；
2. 写入同目录临时文件并执行 `fsync`；
3. 原子改名为不可变目标路径，并同步目录；
4. SQLite `BEGIN IMMEDIATE` 事务写入 chunk、upload ID 和 stream 游标；
5. 提交事务后返回 `accepted`。

如果文件已写入但数据库事务未提交，该文件不会得到成功确认，并会被 `orphanRawFiles()` 识别。相同目标路径不会被覆盖，已有内容必须与声明 hash 一致。

## SQLite 内容

- `streams`：每个 Run/File/Generation 的 next offset 与 previous hash；
- `chunks`：不可变块的 metadata、原始路径、接收时间和解析状态；
- `upload_ids`：所有已确认 upload ID 的幂等指纹，包括相同区间使用新 upload ID 的重试。

新块的 `parser_status` 初始为 `pending`。POC-05 从该队列读取并更新解析结果。
