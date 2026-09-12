# AgentScope Orchestrator 实施地图

本文件把 `agentscope_orchestrator_codex_spec.md` 与
`agentscope_orchestrator_user_plan.md` 转换为当前仓库可以逐步落地、逐步验收的工程计划。
实施分支为 `orchestrator`；每个功能点完成后单独创建一次本地提交，不推送远程。

## 目标与边界

目标是保留现有 Monitor V0 的稳定能力，同时增加一个可恢复、可验证、单 Worker 串行执行的
Orchestrator：用户提交一个较大的 Goal 后，系统负责建立路线图、逐个执行 Task、采集证据、
独立验证、有限修复重试，并在完成、失败或需要人工判断时停下来。

首期明确采用保守边界：

- 同一时间只允许一个 Goal、一个活动 Task、一个 coding Worker；不做并行、DAG、worktree、自动合并。
- Worker 只能提交“声明结果”，不能自行决定 Task 或 Goal 已完成；完成状态必须由证据与 Verifier 产生。
- 规划器、Worker、Verifier 分离；Dashboard 与 CLI 只调用 Orchestrator Core，不直接启动 Provider。
- 优先复用现有 Session/Turn/Event、观察器、WebSocket 与 Dashboard 数据通路。
- 不引入向量数据库、知识图谱、跨机器协作、完整 TTY 中途编辑等非目标能力。
- 原有 `run claude`、`run codex`、TTY、Dashboard、恢复与历史数据行为保持兼容。

## 现有架构到新模块的映射

| 规格概念 | 首期落点 | 约束 |
| --- | --- | --- |
| Goal/Task/Attempt/Verification/Event | `@agentscope/storage` 新增持久化表、类型和事务仓储 | 与 Monitor 表分离；删除 Goal 时级联删除其 Orchestrator 数据 |
| Orchestrator Core | 新增 `@agentscope/orchestrator` 包 | 只依赖 storage/protocol，不绕过仓储写 SQLite |
| Project Context | Orchestrator 的确定性 Bootstrap 模块 | 只读取 Git、manifest、README、目录和可发现命令，不上传全仓库 |
| Initial/Rolling Planner | Planner 接口 + 保守默认实现 | 只产出路线图/Task 建议；不能直接改状态为完成 |
| Worker Runtime | CLI 注入现有 Provider runner 的适配器 | 一个 Task 一个 Attempt；Session 与 Attempt 建立关联 |
| Evidence/Verifier | 确定性证据采集器与独立 Verifier | Git、文件、命令、测试、构建、类型检查优先；未知显示 UNCERTAIN |
| Repair/Retry | Orchestrator 状态机 | 默认最多 3 次；超限进入 `NEEDS_HUMAN` |
| UI/API | 复用现有 Fastify/WS，在其上增加 Goal 资源 | 前端只发 HTTP/WS 意图，不直接生成进程 |
| Crash Recovery | 启动扫描 running 状态并保守对账 | 无法确认的 Attempt 不重复启动，转 `NEEDS_HUMAN` |

## 状态与数据约束

### Goal

`CREATED → PLANNING → RUNNING ↔ VERIFYING → (COMPLETED | FAILED | PAUSED | NEEDS_HUMAN | ABORTED)`。
只有最终验证通过才能进入 `COMPLETED`；`FAILED` 只表示系统确认失败，不把 Worker 的自报失败当作唯一依据。

### TaskContract

每个 Task 必须包含标题、目标、验收标准、验证命令/规则、约束、最大尝试次数、序号和是否 tentative。
Task 状态使用 `PENDING/RUNNING/VERIFYING/REPAIRING/COMPLETED/FAILED/SKIPPED/NEEDS_HUMAN`。

### Attempt/Verification

Attempt 记录 provider、关联 Session、尝试号和 WorkerResult；VerificationRun 记录标准、确定性检查、证据、
结论及原因。原始 Provider 历史仍由现有 Monitor 表保存，Orchestrator 只保存结构化引用和摘要。

## 分阶段执行与提交点

每个阶段都必须先有自动测试，再创建对应提交；测试失败时停在当前阶段修复，不进入下一阶段。

1. **规格与实施地图（当前）**：纳入规格文件，记录边界、映射、状态与验收顺序。
2. **领域模型与持久化**：新增类型、状态迁移、SQLite migration、事务仓储、索引和仓储测试。
3. **Project Context**：实现确定性 Bootstrap、ProjectState、ExecutionMemory、WorkingSet 及脱离网络的测试夹具。
4. **Planner**：实现初始路线图、首个锁定 Task、2–4 个 tentative Task 及滚动规划接口；不能越权完成任务。
5. **Worker Runtime**：把 TaskContract 转成现有 Claude/Codex runner 输入，建立 Attempt↔Session 关联，串行互斥。
6. **Evidence 与 Verifier**：采集 diff/status/文件/命令/测试/类型检查/构建/事件证据，独立计算 PASS/FAIL/UNCERTAIN。
7. **Repair/Retry**：验证失败后生成带证据的修复 Attempt，默认最多三次，超限暂停并请求人工处理。
8. **Autonomous Loop**：串接规划、执行、验证、修复、滚动规划；Goal 只能在最终验证通过后完成。
9. **Goal Final Verification**：重新对照原始 Goal 与所有 acceptance criteria，发现缺口生成 Gap Task。
10. **API/Dashboard**：增加最小 Goal 读取/启动/暂停/中止/继续及详情展示，保持现有 Monitor API/UI 兼容。
11. **Recovery 与验收**：实现崩溃恢复、活动 Attempt 去重、人工介入路径，并跑真实安全小任务与完整 release gate。

## 每阶段的最小验收标准

- 领域/持久化：重启后 Goal、Task、Attempt、Verification、Event 完整恢复；非法状态迁移被拒绝。
- Context：同一夹具多次运行输出稳定；不执行写操作，不读取 `.env` 内容，不把全仓库作为提示词。
- Planner：首个 Task 锁定且带验收标准；tentative Task 数量为 2–4；规划器不能写完成状态。
- Worker：同一 Goal 同时只能有一个活动 Attempt；Provider 失败可记录并释放锁。
- Verifier：Worker 声称完成但证据不满足时必须是 FAIL/UNCERTAIN，不得误报 PASS。
- Repair：失败最多三次；三次后状态为 NEEDS_HUMAN，不能无限循环。
- Loop/Final：至少完成一个安全文件修改任务、一个验证失败再修复任务、一个需要人工介入任务。
- UI/Recovery：Dashboard 实时看到 Goal/Task/Attempt/Verification 时间线；进程重启后不重复执行活动 Attempt。
- 发布门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、
  `pnpm test:integration`、`pnpm build` 全部通过；最后补跑 `pnpm release:check`。

## 保守决策记录

- Planner 首期保留接口和确定性默认实现，先把状态、证据和恢复做可靠，再接入可能产生幻觉的自由文本规划。
- 验证命令默认使用结构化 executable/args；对无法安全解析的命令只记录 UNCERTAIN，不使用 shell 拼接。
- 任何缺少事件、退出码、文件或命令证据的完成声明都不会自动提升为 PASS。
- 删除、覆盖、远程推送不属于 Orchestrator 自动动作；人工 Abort/删除仍沿用现有安全保护。

