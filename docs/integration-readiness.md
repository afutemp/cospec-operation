# 集成前运行与冒烟检查

本流程验证独立 Collector 和 Server 可以工作，不调用或修改 `cospec-router`。

## 配置

| 变量 | 组件 | 必填/默认 | 含义 |
|---|---|---|---|
| `COSPEC_TELEMETRY_BEARER_TOKEN` | Server | 必填 | 部署只读看板 Token，不用于 Collector 上报 |
| `COSPEC_TELEMETRY_SERVER_URL` | Collector | 未设置则写本地 outbox | 例如 `http://127.0.0.1:4318` |
| `COSPEC_TELEMETRY_STORAGE_DIR` | Server | `./storage` | SQLite 与不可变原始块根目录 |
| `COSPEC_TELEMETRY_HOST` | Server | `127.0.0.1` | 监听地址 |
| `COSPEC_TELEMETRY_PORT` | Server | `4318` | 监听端口 |
| `COSPEC_TELEMETRY_STATE_DIR` | Collector | 平台用户状态目录 | Collector JSON 状态与离线 outbox |
| `COSPEC_TELEMETRY_SCAN_INTERVAL_MS` | Collector | `300000` | 后台扫描周期；主要用于自动化测试覆盖 |
| `CODEX_SESSIONS_ROOT` | Collector | Codex 默认 sessions 目录 | 测试或非默认安装时覆盖 |
| `CODEX_SESSION_ID` | Collector CLI | 可由 `--session-id` 代替 | 精确关联 JSONL 的 Agent Session ID |
| `CLAUDE_CODE_PROJECTS_ROOT` | Collector | `~/.claude/projects` | Claude Code projects 根目录 |
| `CLAUDE_SESSION_ID` | Collector CLI | 可由 `--session-id` 代替 | 精确关联 Claude Code JSONL |

Server 缺少看板 Token、端口非法时会在监听前失败。Collector 只需 Server URL，无需上报 Token。daemon 会继承首次拉起它的环境；改变 URL 后先执行 `shutdown`。

Collector 默认每 5 分钟后台扫描一次。`ensure` 后异步立即扫描，`finish` 和显式 `scan` 立即扫描；因此正常短 Run 通常由开始和结束动作完成采集，不依赖高频轮询。

## 手工冒烟流程

```bash
npm install
npm run check
npm test

export COSPEC_TELEMETRY_BEARER_TOKEN="<temporary-test-token>"
export COSPEC_TELEMETRY_STORAGE_DIR="<temporary-storage-directory>"
npm run server
```

在另一个终端确认服务，然后创建 Run。`run-id` 由当前手工验证者生成；未来才由 Router 提供。

```bash
curl --noproxy 127.0.0.1 http://127.0.0.1:4318/health/live
curl --noproxy 127.0.0.1 http://127.0.0.1:4318/health/ready

export COSPEC_TELEMETRY_SERVER_URL="http://127.0.0.1:4318"
node dist/collector/cli.js ensure \
  --agent codex \
  --session-id "$CODEX_SESSION_ID" \
  --run-id "<UUID>"

node dist/collector/cli.js status
node dist/collector/cli.js scan
curl --noproxy 127.0.0.1 \
  -H "Authorization: Bearer <temporary-test-token>" \
  http://127.0.0.1:4318/api/v1/runs/<UUID>

node dist/collector/cli.js finish --run-id "<UUID>" --status completed
node dist/collector/cli.js shutdown
```

`finish` 成功表示结束边界已经记录并补传到该边界。之后同一 Agent Session 的普通 JSONL 增长不会再归入这个 Run。

## 当前非阻塞限制

- Windows 代码路径存在，但 Named Pipe、状态目录、轮转和完整 E2E 尚未在 Windows 实机验收；
- Claude Code 已按 2.1.220 验证，其他版本和 Windows 实机行为尚未验证；
- 尚未提供系统服务安装、TLS、密钥分发、生产存储运维和保留/删除策略；
- 重放仅由服务端 CLI 手工触发；
- 页面、Artifact 与运营指标不在当前基线内。
