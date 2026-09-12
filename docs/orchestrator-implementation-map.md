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

## 当前落地状态（`orchestrator` 分支）

截至本分支当前提交，以下能力已经落地并有自动测试覆盖：

- [x] Goal/Task/Attempt/Verification/Event 持久化、显式状态迁移和 SQLite 迁移。
- [x] 单活动 Goal 的数据库约束；多进程竞争会返回可识别的冲突，不会并行执行。
- [x] 确定性 Project Context Bootstrap，过滤敏感路径，不读取 `.env` 内容。
- [x] 保守 Initial Planner、Rolling Planner 和结构化 Task Contract。
- [x] 串行 Worker Runtime，与现有 Claude/Codex provider runner 适配。
- [x] Git、文件、结构化命令和测试/构建/类型检查证据的独立 Verifier。
- [x] 有界修复重试、`NEEDS_HUMAN`、Pause/Continue/Abort 和运行时异常安全收尾。
- [x] 最终 Goal 多 Task 复核；确定性失败会持久化 Gap Task。
- [x] CLI `orchestrate` 命令、Server Goal API、WebSocket 广播和 Dashboard Goal 详情时间线。
- [x] 启动恢复对活动 Attempt 加围栏，拒绝重复执行并保留人工介入路径。
- [x] 临时工作区真实文件修改 + 确定性验证的集成验收。

尚未把外部服务凭据写入自动化测试：真实 Claude/Codex 长任务仍应由使用者在目标机器上做一次验收；这不影响本地核心、存储、API、Dashboard 和安全任务测试。

最近一次本地门禁记录：`format:check`、`lint`、`typecheck`、单 worker 全量测试（306 tests）、集成测试（6 tests）和 `build` 均通过。文件系统高并发用例在并行全量运行时曾超时，单独重跑及单 worker 全量运行均通过；发布门禁采用后者以避免 Windows 文件系统资源争用。

## V1 Step 0.1 能力矩阵（`codex/orchestrator-v1` 基线）

本矩阵以当前工作树的真实实现为准，不把 V1 计划文档中的目标误认为已经完成。状态含义：

- **已具备**：已有实现和自动测试可复用，V1 只需回归或小幅扩展。
- **部分具备**：有可复用基础，但缺少 V1 要求的持久化、并发、解释或 UI 语义。
- **未开始**：当前没有可直接提供 V1 行为的实现。

| V1 能力 | 当前状态 | 已有落点 | V1 差距与风险 |
| --- | --- | --- | --- |
| Goal 历史、分页、筛选、搜索 | 部分具备 | `OrchestratorRepository.listGoals`、Server `GET /api/goals`、Dashboard Goal 列表 | 当前主要是固定 limit；缺少 cursor、查询条件、归档；历史数据增长会影响体验 |
| Goal 归档/恢复显示 | 未开始 | 无 Orchestrator 归档状态或 API | 不能物理删除审计数据；活动 Goal 必须受到保护 |
| Roadmap revision、编辑、插入、跳过、重排 | 部分具备 | Goal `roadmap` JSON、Initial/Rolling Planner、Task `sequence/tentative` | 缺少 immutable revision、并发冲突、用户锁定修改和安全 `SKIPPED` 语义 |
| Human Instruction / Give Instruction | 未开始 | Continue 目前只恢复既有流程 | 缺少指令实体、校验、边界应用、审计和 CLI/API/UI 入口 |
| Resume / Retry | 部分具备 | `OrchestratorEngine.resumeGoal`、内部 Repair Loop、`recoverOrchestrator` | 缺少 durable lease、跨进程 owner、显式 Retry API、幂等控制和细粒度恢复分类 |
| 崩溃恢复与运行租约 | 部分具备 | Recovery 对活动 Attempt 加围栏；Server 启动恢复 | 当前依赖启动扫描，未有 generation/heartbeat/接管语义；不确定状态仍需更清楚的用户解释 |
| Execution Memory 版本与来源 | 部分具备 | Goal 的 `executionMemory`、Bootstrap/rolling planning | 当前是单个 JSON 快照，缺少版本、来源引用、压缩 invariant 和历史查询 |
| Project State / Working Set 边界刷新 | 部分具备 | Bootstrap `ProjectState`、`WorkingSet` | 缺少每个指令/Attempt/Task 边界的增量刷新和变更原因 |
| 风险分类、审批、预算 | 未开始 | Task 只有静态 constraints/maxAttempts | 缺少动作风险、ApprovalRequest、Provider 权限映射、时间/usage 上限 |
| Goal/Task Progress 与 ETA | 部分具备 | Monitor Session/Turn progress/ETA | Orchestrator 尚无独立 Goal/Task snapshot、历史样本、置信度/区间和 Gap Task 解释 |
| Orchestrator 通知 | 部分具备 | Dashboard 浏览器通知、Server WebSocket | 缺少 NEEDS_HUMAN/Approval/Budget 规则、durable eventKey、通知中心和已读状态 |
| Agent Control Center UI | 部分具备 | Goal 创建、详情、Pause/Abort/Continue、Task/Attempt/Verification 时间线 | 缺少历史导航、Instruction、Roadmap 编辑、Recovery/Approval、指标解释和异常状态体验 |
| Claude/Codex Worker 一致性 | 部分具备 | 现有 Provider runner、Attempt↔Session 关联、真实 smoke | 缺少 V1 capability matrix、统一失败 taxonomy、退避/取消和 usage 能力降级记录 |
| 可靠性/性能/长期稳定性 | 已具备（V0 基线） | `pnpm release:check`、集成测试和 V0 real-task 记录 | 需要新增 V1 故障注入、控制面并发、历史容量、ETA 校准和 soak 指标 |
| V0 Monitor 兼容性 | 已具备（必须持续回归） | Claude/Codex TTY、structured、app-server、Session/Turn/Evidence | 任何 V1 migration、Server、WS、Dashboard 变更都必须跑回归门禁 |

### V1 实施顺序冻结

Step 0.1 的结论是：先实现 **持久化与历史查询（Phase 1）**，再实现 **租约/恢复/幂等（Phase 2）**，之后才开放
Instruction 和 Roadmap 编辑。Progress/ETA、通知和 UI 必须消费后端持久化快照，不能由前端自行推算。V1 仍不进入
V2 的并行 Worker、DAG、worktree、自动 merge 或智能 Provider Router。

Step 0.1 已完成；下一步是 Step 0.2 的状态与安全语义测试夹具，然后才开始第一条运行时 migration。
