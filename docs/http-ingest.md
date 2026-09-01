# HTTP 上传与接收（POC-03）

## 启动持久化接收端

```bash
npm run build
COSPEC_TELEMETRY_BEARER_TOKEN="<test-token>" \
COSPEC_TELEMETRY_STORAGE_DIR="<storage-directory>" \
npm run server
```

默认监听 `127.0.0.1:4318`。可通过 `COSPEC_TELEMETRY_HOST` 和 `COSPEC_TELEMETRY_PORT` 修改。

无需鉴权的 `GET /health/live` 用于判断进程存活，`GET /health/ready` 用于判断持久仓储可查询。它们只返回状态，不返回配置、路径或业务数据。上传和查询接口仍要求 Bearer Token。

## 启动 Collector HTTP 上传

```bash
COSPEC_TELEMETRY_SERVER_URL="http://127.0.0.1:4318" \
COSPEC_TELEMETRY_BEARER_TOKEN="<test-token>" \
node dist/collector/cli.js ensure \
  --session-id "$CODEX_SESSION_ID" \
  --run-id "<UUID>"
```

配置 `COSPEC_TELEMETRY_SERVER_URL` 后使用真实 multipart HTTP；未配置时仍使用 POC-02 的本地 outbox 模拟接收端。Token 只用于 Authorization header。

## 当前边界

`createIngestApp()` 默认内存仓储只用于协议测试。正式 CLI 入口已在 POC-04 接入 SQLite 和不可变文件存储，在可靠落盘后才返回成功；详见 [durable-storage.md](durable-storage.md)。
