# Web 运营看板

## 页面

- `/`：运营总览，默认最近 30 天，支持今天、本周、本月、最近 7/30/90 天、自定义时间，以及 Agent、版本和模型筛选；
- `/runs`：分页 Run 列表；
- `/runs/:runId`：Run 概况、资源与上下文、工具与子代理、采集与解析详情；
- `/login`：输入服务端 Bearer Token。

Token 只保存在当前浏览器标签页的内存中，不写入本地存储，不进入前端构建产物。刷新或关闭页面后需要重新输入。

## 运行

```bash
npm run build
COSPEC_TELEMETRY_BEARER_TOKEN=<token> npm run server
```

开发时分别运行服务端和 `npm run web:dev`，Vite 将 `/api` 与 `/health` 代理到 `127.0.0.1:4318`。

## 验证

```bash
npm test
npx playwright install chromium
npm run test:e2e
```

Playwright 是固定的开发依赖，不进入页面运行链路。验收使用临时 SQLite 和合成 JSONL，不依赖用户真实数据。

## 口径

- 缺失值显示“暂无数据”，不补成 0；
- 页面只在筛选变化或用户手动刷新时请求数据，并显示最近更新时间；
- 输入和输出 Token 分开显示；
- 明确失败与状态覆盖率同时展示；
- Claude Code 上下文上限不可得时明确说明，不按模型推断；
- 不展示 JSONL 正文、工具参数、工具输出和本地文件路径。
