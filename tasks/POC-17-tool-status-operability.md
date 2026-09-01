# POC-17 收紧工具状态运营口径

## 结论

- [x] Codex 工具状态标记为部分可得：`exit_code` 可能被外层 `functions.exec` 丢弃；
- [x] 明确失败次数只作为实际失败数的下界，不作为完整失败量；
- [x] 不发布未附带覆盖率的统一工具成功率或失败率；
- [x] Claude Code 同样只使用显式 `is_error`，缺失时保持 unknown；
- [x] 不根据工具正文或业务文本猜测状态。

## 查询口径

- [x] 返回 `determined_results = successes + failures`；
- [x] 返回 `unknown_results = calls - determined_results`，包含没有结果和结果不可判定的调用；
- [x] 返回 `status_coverage = determined_results / calls`；
- [x] 按工具维度使用同一口径。

详细证据与使用限制见 [宿主资源与工具事实 0.2](../docs/host-resource-facts-v0.2.md)。
