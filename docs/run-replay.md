# Run 级解析重放（POC-06）

## 命令

```bash
npm run build
COSPEC_TELEMETRY_STORAGE_DIR="<server-storage>" \
npm run replay -- --run-id "<UUID>" --parser-version "<installed-version>"
```

必须显式指定 Run ID 和已安装解析器版本；命令不提供隐式全量重放。

## 生效规则

1. 按原始 offset 顺序读取 Run 的全部不可变块；
2. 每块重新校验 SHA-256；
3. 新版本结果以 `upload_id + parser_version` 保存，旧结果不修改；
4. 所有块为 `completed` 或 `completed_with_errors` 后，事务切换 Run 的 active version；
5. 任一块读取、hash 或解析失败，任务记为 failed，active version 不变。

失败任务不自动重试。相同 Run 与目标版本的重复请求返回原任务；如未来需要再次执行，应显式设计新的 attempt 语义，不静默覆盖历史任务。

## 任务记录

`replay_jobs` 保存 Run、目标版本、状态、总块数、成功块数、失败数、失败码和开始结束时间。部分生成的新版本结果可以保留诊断，但查询只使用 `active_parser_versions` 指向的版本。
