# AgentScope V1 可靠性指标口径

本文档定义 Orchestrator 的本地可靠性指标。所有指标都来自 SQLite 中已经保存的 Goal、Task、Attempt、Verification 和审计事件；没有证据的字段显示为 N/A 或 `unavailable`，不以零代替。

## 指标定义

- **Task Success Rate**：`COMPLETED Task 数 / (COMPLETED + FAILED + NEEDS_HUMAN Task 数)`。`SKIPPED` 不进入分母，因为跳过不是成功执行。
- **Average Repair Attempts**：对至少有一次 Attempt 的 Task，计算 `max(0, Attempt 数 - 1)` 的平均值。没有 Attempt 时为 N/A。
- **Human Intervention Rate**：发生过 `NEEDS_HUMAN`、Approval 请求、恢复需人工或预算超限证据的 Goal 数 / Goal 总数；同一 Goal 只计一次。
- **Runtime**：终态 Goal 从 `createdAt` 到 `completedAt`（没有该字段时使用 `updatedAt`）的秒数，提供样本数、平均值、P50 和 P95。
- **Token/Cost**：只汇总 Worker 实际报告的 usage。全部 Attempt 都报告时为 `available`，部分报告时为 `partial`，没有报告时为 `unavailable`；缺少的字段不补零。
- **False Completion Rate（proxy）**：已完成 Goal 中，后来出现 `goal.verification.completed` 为 `FAIL/UNCERTAIN` 或 `goal.gap_task.created` 证据的 Goal 数 / Goal 总数。它是可观察的误完成代理，不声称能发现没有被记录的错误。

归档 Goal 默认仍包含在历史统计中；调用方如只需活动范围，应在传入计算器前过滤。时间范围、Provider 和工作区筛选同样由调用方在查询层显式完成。
