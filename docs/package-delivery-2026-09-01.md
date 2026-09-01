# npm 安装与交付验收记录（2026-09-01）

## 范围

从仓库执行 `npm pack`，在仓库外的全新临时 npm 项目安装 tarball。验证过程不使用 Router、真实 JSONL 或源码目录内的 `node_modules`。

## 结果

- `prepack` 自动清理并重新生成生产 `dist/`；
- tarball 大小 33,245 bytes，解包后 150,538 bytes，共 60 个文件；
- 内容仅包含 README、三个 JSON Schema、生产 JavaScript、source map、类型声明和 package 元数据；
- 未包含测试、`tasks/`、`docs/`、源码、SQLite、Collector 状态或原始遥测数据；
- 安装后生成 `cospec-telemetry`、`cospec-telemetry-server`、`cospec-telemetry-replay` 三个命令；
- 三个命令缺少必需输入时均以非零状态退出，并返回明确错误；
- 安装后的 Collector 可自动拉起 daemon、返回空状态并安全关闭；
- 安装后的 Server 可创建全新持久存储，`/health/live` 和 `/health/ready` 均返回 200；
- 未带 token 的查询返回 401；Server 收到 SIGINT 后退出码为 0。

## 源码回归

`npm run check && npm test` 通过，28/28 测试通过。Node.js 24 的 `node:sqlite` 仍会打印已接受的 ExperimentalWarning。

## 未覆盖

- 未发布到 npm registry；
- 未在 Windows 实机安装；
- 未验证系统级服务安装或升级/卸载；
- 正式环境的签名、制品仓库和供应链检查不属于当前 PoC。
