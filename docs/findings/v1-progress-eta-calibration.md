# V1 Progress / ETA 校准基线

**日期：** 2026-09-13  
**测试入口：** `packages/orchestrator/src/v1-calibration.test.ts`、
`packages/eta/src/index.test.ts`

## 目标

本基线只验证可重复的投影规则，不把少量样本包装成精确预测模型。Progress 负责说明
“已经完成多少”，ETA 负责给出保守剩余区间；两者都必须携带可解释的 confidence/reasons。

## 合成历史矩阵

| 场景 | 合成输入 | 必须满足的结果 |
|---|---|---|
| 冷启动 | 无可比历史 | `sampleCount=0`，原因包含 `history_unavailable`，返回宽区间/低置信度 |
| 少量样本 | 1–2 个成功样本 | 原因包含 `history_cold_start`，不出现 `history_baseline`，confidence ≤ 0.35 |
| 充足样本 | ≥3 个同 workspace/provider/profile 的成功样本 | 使用 `history_baseline` 与 `history_range`，保留 p25–p75 区间 |
| 异常样本 | 失败、不同 Provider/workspace、NaN/0 时长、极端 outlier | 不进入基线；排除数量通过 `history_outliers_excluded` 解释 |
| 超出历史 ETA | elapsed 超过历史 p75 | 区间按当前 elapsed 重新计算，增加 `history_overrun`，confidence 乘以 0.65 |
| 小 Task 完成 | Task 已完成但 Goal final verification 未通过/缺失 | Task 可到 100%；Goal 保持低于 100% 并说明验证缺口 |
| Goal 完成 | 所有 Task 完成且 final verification PASS | Goal progress 精确为 1，confidence 精确为 1 |

## 置信度与误差定义

1. 少于 3 个可比完成样本时，系统只承诺保守范围和低置信度，不承诺点 ETA。
2. 至少 3 个样本时，历史中位数用于中心估计，p25–p75 用于解释区间；样本数量增加只会
   逐步提高历史权重，不会跳变为“确定答案”。
3. 当实际 elapsed 超过历史 p75 时，必须留下 `history_overrun` 并降低 confidence；这表示
   原基线已经被当前任务突破，用户应以重新计算后的区间为准。
4. 在真实项目积累至少 20 个同 scope 的成功样本前，不发布统计覆盖率或 P50/P95 承诺。
   达到该数量后，再以“实际总时长落在 p25–p75 的比例”和绝对误差中位数作为校准指标，
   不以单次任务结论替代统计结果。
5. 所有投影均要求 `0 ≤ value/confidence ≤ 1`、`0 ≤ minSeconds ≤ maxSeconds`；终态 ETA
   固定为 0–0 秒，终态 Progress 是否为 100% 取决于验证证据。

## 运行结果

在 2026-09-13 的本地验证中，ETA 与 Goal Progress 校准矩阵共 160 个单元测试通过；其中
新增的 11 个断言覆盖 0/2/6 样本、历史 p75 超时、outlier/失败过滤和完成验证门槛。

运行命令：

```text
node node_modules/.pnpm/vitest@*/node_modules/vitest/vitest.mjs run packages/eta/src packages/orchestrator/src
```

当前基线为确定性规则测试，不代表真实 Provider 的平均响应时延。真实 Provider 的结果见
`docs/findings/v1-real-provider-acceptance.md`；后续性能阶段会在不改变这些保守语义的前提下
补充批量历史、分页和长时运行数据。
