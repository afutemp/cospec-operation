# POC-43 上报接口取消 Token

- [x] JSONL 数据块、Run 生命周期事件和正式产物上报无需 Token
- [x] Collector 在未配置 Token 时正常进行 HTTP 上报
- [x] 看板查询、用户管理和原始 JSONL 下载继续鉴权
- [x] Cospec 集成分支内置当前运营服务地址，并允许环境变量覆盖
- [x] 重新生成随 Cospec 分发的单文件 Collector
- [x] 内容校验、幂等、连续性与大小限制保持不变
- [x] Collector、服务端、前端、Cospec 集成及 Chromium 端到端测试通过

当前集成分支默认地址为 `http://10.0.0.254:4318`。正式发布前应替换为稳定的 HTTPS 域名。
