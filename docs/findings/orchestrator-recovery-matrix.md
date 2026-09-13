# Orchestrator fault-injection and recovery matrix

V1 的故障注入测试只使用临时 SQLite 数据库和临时 workspace。测试不会触碰
真实 Provider、用户工作区或远程仓库；每个故障点都在可重复的边界注入，随后
检查持久化状态、事件和恢复后的 Attempt 数量。

| 注入点 | 故障后的持久化边界 | 恢复动作 | 关键不变量 |
| --- | --- | --- | --- |
| Planning / context bootstrap | Goal=`NEEDS_HUMAN`，Task 尚未创建，记录 `goal.run_failed` | 新进程显式确认 Provider 已停止后 `resumeGoal` | 不产生 phantom Task；恢复后只创建一个 Task/Attempt |
| Worker start / spawn | Attempt、Task 和 Goal 进入 `NEEDS_HUMAN`，失败归类为 `spawn_error` | 显式确认后创建 replacement Attempt | 启动失败不自动重试，不留下活动 Attempt |
| Worker running / transient network | Attempt=`FAILED`，保存规范化 `network` failure；验证结果被降级为 `FAIL` | 在有上限的 backoff 后重试 | Worker 失败不能被“验证器 PASS”伪装成完成；不重复活动 Attempt |
| Verification | Attempt 已完成，Task 停在 `VERIFYING`，Goal=`NEEDS_HUMAN` | 恢复时先把验证边界 fence 到 `NEEDS_HUMAN`，再显式确认并重跑 | 不重复使用未知的验证结果；恢复后产生新的 Attempt |
| Roadmap revision write / SQLite busy | Task 可能已经落库，但没有对应 revision 行；Goal=`NEEDS_HUMAN` | 重开数据库并恢复，重新协调 roadmap 后继续 | 不出现半条 revision；Task 不重复；active revision 单调 |
| Notification persistence | 事件和 Goal 状态照常落库，notification sink 可能没有记录 | 不需要恢复动作 | 通知是 best-effort，不改变执行结果，不造成 `goal.run_failed` |
| Provider process disappears | `recoverOrchestrator` 将活动 Attempt、Task、Goal fence 为 `NEEDS_HUMAN` | 操作者确认外部进程已停止后 `resumeGoal` | 不自动启动第二个 Worker；最多一个 replacement Attempt |
| Server restart / WebSocket loss | SQLite 状态和事件序列保留；WebSocket 连接可丢失 | 通过 HTTP snapshot/cursor 重新同步 | 实时通道故障不影响 HTTP 快照或历史事件 |

自动化覆盖位于
`tests/integration/orchestrator-fault-recovery.test.ts`，并与现有的
`tests/integration/server-recovery.test.ts` 一起运行。主要断言包括：

- 不存在 `CREATED`/`RUNNING` 的重复 Attempt；
- Goal 只有在 Task 和最终验证均完成时才会变为 `COMPLETED`；
- 用户指令、失败分类、验证证据和恢复事件保留在同一 Goal 下；
- revision 写入失败时不会留下可见的 revision 行或错误的 active revision；
- notification、metric 和 WebSocket 等观察性投影不会反向破坏执行关键路径。

运行方式：

```text
pnpm test:integration
```

这个矩阵不把外部 Provider 的原始 stderr 或密钥写入数据库。真实 Provider
验收仍在 Step 11.4 单独进行，并沿用同一套恢复不变量。
