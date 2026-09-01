# POC-10 安装与交付验证

> 状态：已完成。不发布到 npm registry，不修改 `cospec-router`。

## 目标

证明仓库可生成一个不依赖源码目录状态的安装包，并能在全新目录安装和运行 Collector、Server、Replay 三个命令入口。

## 执行项

- [x] `npm pack` 前自动执行生产构建，不依赖残留的 `dist/`；
- [x] 安装包只包含运行时编译产物、JSON Schema、README 和 npm 元数据；
- [x] 安装包不包含测试、任务卡、内部设计文档、原始数据或本地状态；
- [x] 提供 Collector、Server 和 Replay 的稳定 bin 命令；
- [x] 在全新临时目录安装 tarball，验证三个命令可以由 npm 解析；
- [x] 验证缺少必要参数或环境变量时返回非零退出码和明确错误；
- [x] 启动已安装的 Server，验证 live/ready 后安全退出；
- [x] 运行全量源码测试并检查工作区无打包残留。

验收证据见 [npm 安装与交付验收记录](../docs/package-delivery-2026-09-01.md)。

## 完成条件

- 安装验证不引用源码仓库中的 `dist/` 或 `node_modules/`；
- tarball 中不存在 `*.test.*`、`tasks/`、`docs/` 或遥测数据；
- 不需要 Router 或真实 Codex JSONL 即可完成交付验收。
