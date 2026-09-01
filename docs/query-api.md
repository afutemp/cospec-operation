# 只读查询 API（POC-07）

所有接口使用与上传端相同的 Bearer 鉴权。

## Run 列表

```http
GET /api/v1/runs?limit=20&offset=0
```

`limit` 范围为1至100。返回 Run、Agent Session、数据源、块数、字节数、offset 范围、接收时间和 active parser version。

## Run 详情

```http
GET /api/v1/runs/:runId
```

返回上传汇总、解析状态数量，以及当前 active parser version 对应的总行数、合法/非法/未知行数、类型分布和时间范围。非 active 版本不会混入汇总。

## 原始块状态

```http
GET /api/v1/runs/:runId/chunks
```

返回 upload ID、generation、offset、字节数、SHA-256、解析状态、接收时间和 `rawPresent`。不返回原始文件路径或内容。

## 重放历史

```http
GET /api/v1/runs/:runId/replays
```

返回任务 ID、目标版本、状态、块计数、失败码和起止时间。接口只读，不提供重放触发。

## 数据边界

API 不返回消息正文、工具参数、工具输出、原始 JSONL、`path_hint` 或服务端绝对路径。本阶段不提供 HTML 页面；使用接口测试、curl 或其他 HTTP 客户端验证。
