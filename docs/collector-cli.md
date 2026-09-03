# Collector CLI（POC-02）

> 当前用于手动验证，不修改 `cospec-router`。

## 构建

```bash
npm install
npm run build
```

## 开始关联

```bash
node dist/collector/cli.js ensure \
  --agent codex \
  --session-id "$CODEX_SESSION_ID" \
  --run-id "<UUID>"
```

如果 Collector 尚未运行，`ensure` 会拉起用户级后台进程；否则复用现有进程。

## 控制命令

```bash
node dist/collector/cli.js status
node dist/collector/cli.js scan
node dist/collector/cli.js finish --run-id "<UUID>" --status completed
node dist/collector/cli.js shutdown
```

`status` 除 Run、文件游标和待确认上传外，还返回最近扫描、最近成功上传、连续失败、最近错误及恢复时间。持续历史记录位于状态目录的 `logs/collector.jsonl`，详见 [Collector 状态与本地滚动日志](collector-observability.md)。

未配置 `COSPEC_TELEMETRY_SERVER_URL` 时，独立 Collector 将数据块写入状态目录的 `outbox/`，用于离线验证；Cospec 集成脚本会提供默认 Server URL，也允许环境变量覆盖。HTTP 上报无需 Token。未完成行不进入数据块，接收成功后才推进游标。没有活动 Run 时不会采集 JSONL；`finish` 边界之后的内容也不会上传。

Collector daemon 在首次 `ensure`、`status`、`scan`、`finish` 或 `shutdown` 时自动拉起。用于真实上传时，必须在首次拉起前设置 Server URL 和 Token；变更配置后应先执行 `shutdown`，再用新环境重新拉起。

默认后台扫描周期为 5 分钟。`ensure` 建立关联后会立即安排一次扫描，`finish` 和手工 `scan` 会立即执行，不等待后台周期。上传失败时保留同一 pending upload，等待下一轮后台扫描重试。

## 本地目录覆盖

测试时可避免使用默认用户目录：

```bash
COSPEC_TELEMETRY_STATE_DIR="<temporary-directory>" \
CODEX_SESSIONS_ROOT="<fixture-sessions-directory>" \
node dist/collector/cli.js ensure --session-id "<id>" --run-id "<UUID>"
```

自动化测试或受控部署可通过 `COSPEC_TELEMETRY_SCAN_INTERVAL_MS` 覆盖周期；该值必须是至少 10 的整数毫秒。普通用户无需设置。
