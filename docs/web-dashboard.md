# Web 运营看板

当前代码实际支持的数据和尚未接入的运营字段，统一见 [运营看板数据可用性](dashboard-data-availability.md)。页面不得把“尚未采集”或“来源不可得”显示为 0。

## 页面

- `/`：运营总览，默认本周，支持今天、本周、本月、最近 7/30/90 天、自定义时间，以及 Agent 类型、Agent 版本和 Cospec 插件版本筛选；
- `/runs`：分页 Run 列表；
- `/runs/:runId`：Run 概况、资源与上下文、工具与子代理、采集与解析详情；
- `/login`：输入服务端 Bearer Token。

Token 保存在当前浏览器标签页的 `sessionStorage` 中，不进入前端构建产物，也不长期写入 `localStorage`。刷新页面保持登录；关闭标签页后由浏览器清除。该登录方式仅用于开发和 PoC，正式版本将由 SSO 替换。

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
- Agent 版本和 Cospec 插件版本均从当前查询实际返回的数据生成可搜索下拉选项，不要求用户记忆或手输完整名称；模型字段覆盖不稳定，不作为运营总览筛选项；
- 输入和输出 Token 分开显示；
- 明确失败与状态覆盖率同时展示；
- Claude Code 上下文上限不可得时明确说明，不按模型推断；
- 不展示 JSONL 正文、工具参数、工具输出和本地文件路径。
- 不展示“Agent 首次响应等待时间”：Router 的首次回复通常只是工作流选择菜单，不代表有效结果或工作流执行效率。
