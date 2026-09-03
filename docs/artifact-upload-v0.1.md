# 正式产物上传协议 0.1

## 来源与触发

Collector 只消费 Cospec 的 Run artifact manifest。`stage-end` 完成后执行一次增量同步；`run-finish` 的持久重试流程在发送终态前再次同步，因此离线或重启后仍可补传。

Collector 在入队时校验 manifest 声明的 `size_bytes` 和 `sha256`，把当时版本冻结到用户级 `artifact-spool/`。上传成功后删除冻结副本，状态记录继续保留用于去重。

## 上传

```http
POST /api/v1/artifacts
Content-Type: multipart/form-data

metadata = JSON
artifact = 原始文件字节
```

元数据字段包括 `upload_id`、`cospec_run_id`、`skill`、`attempt_id`、`artifact_index`、`artifact_role`、`file_name`、`logical_path`、`content_type`、`size_bytes`、`sha256` 和 `created_at`。

`logical_path` 只允许 `outputs/` 下使用 `/` 分隔的相对路径，例如 `outputs/tr1-requirements-spec/tr1用户需求文档_评审版.md`。Collector 不上传 Linux 或 Windows 绝对路径；无法安全映射时使用 `outputs/<skill>/<file_name>` 作为逻辑归档路径。

- 单文件不得超过 20 MiB；
- 第一版整文件上传，失败使用相同 upload ID 重试；
- 幂等身份为 Run、Skill、attempt、产物序号和 SHA-256；
- 文件名只用于展示，不参与服务端路径拼接；
- 逻辑路径只用于页面目录树，不参与服务端物理路径拼接；
- 服务端按内容 SHA-256 写入不可变文件。

## 查询与下载

- `GET /api/v1/runs/:runId/artifacts`：列出 Run 已接收产物；
- `GET /api/v1/artifacts/:uploadId/download`：下载原始产物。

两个接口都要求 Bearer 鉴权。下载响应使用 `attachment` 和 `Cache-Control: no-store`，产物目录不通过静态文件服务暴露。
