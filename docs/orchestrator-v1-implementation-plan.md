# AgentScope Orchestrator V1 详细实施计划

> 状态：实施完成（Phase 0–12 已完成；V1 本地 release gate 已通过）
>
> 基线分支：`codex/orchestrator-v1`
>
> 依据：`agentscope_orchestrator_codex_spec.md`、`agentscope_orchestrator_user_plan.md`、当前 V0 实现
>
> 本文用途：作为 V1 的工程规格、执行顺序、逐步验收清单、本地提交清单和最终实施记录
> 约束：V1 实施按本文顺序完成；未进入 V1 的能力仍不得在实现或文档中包装成已支持

## 1. V1 定位

Orchestrator V0 已经完成最小自主闭环：用户提交 Goal 后，系统能够建立路线图、生成 Task Contract、调用单个
Claude/Codex Worker、独立采集证据、执行确定性验证、有限修复重试、滚动规划，并在最终 Goal 验证通过后结束。

V1 的目标不是立刻进入多 Agent，而是把这条单 Worker 链路升级成可长期使用、可干预、可恢复、可审计的
**Agent Control Center**：

> 用户可以在不中断安全边界的前提下向运行中的 Goal 补充指令、调整尚未执行的路线图、处理风险审批、可靠恢复
> 中断任务，并在 Dashboard 中清楚理解系统为什么继续、暂停、重试或宣告完成。

V1 仍坚持一个 Goal 同一时刻最多一个活动 Task、一个 Worker Attempt。所有完成结论继续以独立证据为准，不能因
Worker 自报完成、人工编辑路线图或恢复操作而绕过 Verifier。

## 2. V0 基线与 V1 增量

### 2.1 已有基线

- Goal、Task、Attempt、Verification、Event 已持久化到现有 SQLite 存储层。
- 单活动 Goal、单活动 Attempt、串行 Task 执行已有互斥保护。
- Project Context、Project State、Execution Memory、Working Set 已有保守实现。
- Initial Planner、Rolling Planner、Task Contract、Repair Loop、Goal Final Verifier 已形成闭环。
- Claude/Codex Worker Runtime 已复用现有 AgentScope Session 与观察证据。
- CLI、HTTP API、WebSocket 和 Dashboard 已共享同一 Orchestrator Core。
- Pause、Continue、Abort、`NEEDS_HUMAN` 与保守恢复已有基础能力。
- Monitor 的普通 run、TTY、session、turn、evidence、progress/ETA 等现有功能必须保持兼容。

### 2.2 V1 需要补齐的差距

- Goal 虽然持久化，但历史检索、分页、筛选、归档和 Goal/Session 双向导航还不完整。
- Continue 主要恢复状态，尚未形成持久化的“补充指令 → 校验 → 安全边界应用 → 审计”链路。
- 路线图可展示但不可安全编辑，缺少 revision、冲突检测、插入、跳过和重排语义。
- 恢复逻辑偏保守，缺少明确的运行所有权、幂等控制和面向用户的恢复决策解释。
- Execution Memory 需要版本、来源、决策稳定性和压缩策略，避免长任务中上下文漂移。
- 风险动作、权限、预算和审批还没有成为统一的 Orchestrator 状态。
- Orchestrator 的 Goal/Task progress、ETA、可靠性指标和通知仍需增强。
- Dashboard 还不是完整的 Agent Control Center，控制动作的反馈、冲突处理和可访问性需要完善。

## 3. 不可妥协的设计原则

1. **单 Worker 优先。** V1 不实现并行 Worker、DAG 调度或自动合并。
2. **证据先于声明。** Worker、Planner、用户编辑均不能直接把 Task/Goal 标记为完成。
3. **角色隔离。** Planner、Worker、Verifier 的输入、权限和职责保持分离。
4. **安全边界应用。** 普通人工指令和路线图编辑只在 Attempt 边界生效；紧急操作使用 Pause/Abort。
5. **历史不可篡改。** 已完成 Task、Attempt、Verification 和审计事件不原地改写。
6. **显式 revision。** 路线图、指令、Memory 和控制动作必须具备版本或幂等标识。
7. **保守恢复。** 无法证明可以安全续跑时进入 `NEEDS_HUMAN`，不盲目重启 Attempt。
8. **单一核心。** UI 与 CLI 继续调用同一个 Orchestrator Service，浏览器不直接启动 Provider。
9. **兼容 Monitor。** 不重写已经稳定的 Claude/Codex TTY、structured、app-server 或观察链路。
10. **可解释。** Progress、ETA、风险、重试和规划变更必须显示来源、置信度或原因。
11. **增量迁移。** 数据库 migration 只向前追加；旧 Goal 和旧 Session 在升级后仍可读取。
12. **有界自治。** 尝试次数、运行时间、命令风险和资源预算都必须有上限。

## 4. V1 范围

### 4.1 必须实现

- 持久化 Goal 历史的分页、筛选、搜索、归档与 Goal/Session 导航。
- 更可靠的 restart/recover/resume/retry，包含租约、幂等和明确恢复结果。
- Human Instruction 持久化模型与 `Give Instruction` / `Continue`。
- 路线图 revision，支持编辑未来 Task、插入 Task、跳过 Task 和重排。
- 更丰富且可追溯的 Execution Memory 与 Working Set 更新。
- 风险分类、审批请求、运行预算和 Provider 权限映射。
- Orchestrator 专用通知与通知去重。
- Goal/Task 级 Progress、ETA range、confidence、reason 与历史统计基线。
- 更成熟的 Control Center UI/UX。
- Claude/Codex 两个现有 Worker Runtime 的一致性加固。
- 故障注入、长任务、真实 Provider 与完整回归验收。

### 4.2 可以实现但必须服从可靠性优先级

- Goal 归档后恢复显示。
- 基于本地历史的 ETA 逐步校准；样本不足时只给低置信度区间。
- Token/cost 指标：仅在 Provider 提供可靠数据时展示，否则明确 `Unavailable`。
- Planner/Verifier 的 Provider-backed 实现：必须置于现有接口后，并保留确定性 fallback。
- 运行中的 instruction queue：只允许在下一个安全边界应用，不直接注入已启动的 Provider 进程。

### 4.3 明确不进入 V1

- 多 Worker 并行、DAG、Worker-to-Worker messaging。
- Git worktree 自动隔离、自动 merge 和冲突自动解决。
- 基于成本/速度/成功率的智能 Provider Router。
- 同一 Goal 中动态切换多个 Provider。
- 多项目并行、跨机器执行、Remote Worker。
- 团队权限、组织治理和多人实时协作。
- 向量数据库、embedding 或知识图谱必选依赖。
- 无限制自动重试或自动批准破坏性动作。
- 把 Orchestrator 变成完整交互式 TTY；V1 人工输入通过受控 Instruction 通道完成。

这些能力保留到 V2。V1 的接口可以为它们保留扩展点，但不得为了未来抽象而增加当前实现复杂度。

## 5. V1 目标架构

```text
CLI ---------------------┐
                         │
Dashboard -> Server API -┼-> Orchestrator Service
                         │        │
                         │        ├-> Goal History / Archive
                         │        ├-> Instruction Manager
                         │        ├-> Roadmap Revision Manager
                         │        ├-> Recovery / Lease Manager
                         │        ├-> Risk / Approval / Budget Policy
                         │        ├-> Memory Manager
                         │        ├-> Planner
                         │        ├-> Worker Runtime
                         │        ├-> Evidence / Verifier
                         │        ├-> Progress / ETA / Metrics
                         │        └-> Notification Manager
                         │
                         └--------------------------+
                                                    |
                                            AgentScope Session
                                                    |
                                             Claude / Codex
                                                    |
                                      Existing Monitor Observability
                                                    |
                                      SQLite / WebSocket / Dashboard
```

V1 继续在现有 `@agentscope/orchestrator`、`@agentscope/storage`、Server、CLI 和 Dashboard 中增量实现，不创建
第二套数据库、第二个 Dashboard 或绕开 Session 的 Provider 启动路径。

## 6. 领域模型与状态语义

### 6.1 建议新增的持久化概念

| 概念 | 关键字段 | 用途 |
| --- | --- | --- |
| `GoalInstruction` | goalId、content、kind、status、baseRevision、createdAt、appliedAt | 保存人工补充、约束、批准或优先级指令 |
| `RoadmapRevision` | goalId、revision、reason、source、createdAt | 保存每次路线图变化及来源 |
| `RoadmapItemRevision` | revisionId、taskId、sequence、tentative、operation | 重建某一 revision 的任务顺序与变更 |
| `MemorySnapshot` | goalId、revision、summary、decisions、issues、questions、sources | 保存可追溯的 Execution Memory |
| `ApprovalRequest` | goalId、taskId、attemptId、risk、action、status、expiresAt | 保存高风险动作的人工决策 |
| `GoalRunLease` | goalId、ownerId、generation、heartbeatAt、expiresAt | 防止重启或多进程重复驱动同一 Goal |
| `GoalMetricSnapshot` | goalId、taskId、progress、eta、confidence、reasons、capturedAt | 保存可解释的实时投影和历史基线 |
| `OrchestratorNotification` | goalId、eventKey、kind、status、createdAt、deliveredAt | 去重并审计关键通知 |

实际表名应遵循当前 storage 约定。可以在不牺牲查询和约束的前提下合并过细的表，但不能把这些状态只放在内存。

### 6.2 Instruction 状态

```text
PENDING -> APPLIED
        -> REJECTED
        -> SUPERSEDED
```

- `PENDING` 只表示已收到，不表示当前 Worker 已读取。
- `APPLIED` 必须记录应用到哪个 roadmap/memory revision，以及在哪个 Task 边界生效。
- 违反 LOCKED 约束或过期 revision 的指令应 `REJECTED`，并提供可读原因。
- 新指令明确替代旧指令时，旧记录改为 `SUPERSEDED`，但不删除历史。

### 6.3 Roadmap 编辑语义

- 已完成 Task 和历史 Attempt 不允许原地编辑。
- 当前 `RUNNING/VERIFYING/REPAIRING` Task 不允许普通编辑；用户应先 Pause，或提交下一个边界生效的 Instruction。
- 编辑未来 Task 会创建新 RoadmapRevision，不覆盖旧 revision。
- “删除未来 Task”在领域层表示 `SKIPPED` 并记录原因，而不是物理删除审计数据。
- 插入 Task 必须包含 Task Contract 最小字段、验收标准与验证策略。
- 重排只允许作用于未开始 Task，并在事务中一次性提交。
- Planner 发现新证据时仍可修订 tentative Task，但必须保留 revision reason。

### 6.4 Retry 与 Resume 语义

- Retry 永远创建新 Attempt，不复用或改写旧 Attempt。
- Resume 从最近一个已确认的安全边界继续，不凭空把中断 Attempt 标记成功。
- 若旧 Worker 进程仍存活，恢复流程不得重复启动新的 Attempt。
- 若无法确定旧 Worker 状态，Goal 进入 `NEEDS_HUMAN` 并给出可选择的安全动作。
- 所有控制命令携带 idempotency key；重复请求必须返回同一结果或明确冲突。

### 6.5 单 Worker 与多 Goal 规则

- 数据库中可存在多个历史 Goal。
- V1 默认仍只允许一个活动 Goal 驱动 Worker。
- V1 不引入自动多 Goal 队列；其他 Goal 可以保持 CREATED/PAUSED，并由用户显式 Start/Resume。
- 该限制必须由数据库约束与运行租约共同保证，而不能只依赖前端禁用按钮。

## 7. API 与实时事件边界

### 7.1 建议的 HTTP 资源

```text
GET    /api/goals?status=&provider=&workspace=&query=&cursor=
GET    /api/goals/:goalId
POST   /api/goals/:goalId/archive
POST   /api/goals/:goalId/unarchive

POST   /api/goals/:goalId/instructions
GET    /api/goals/:goalId/instructions

GET    /api/goals/:goalId/roadmap/revisions
PATCH  /api/goals/:goalId/tasks/:taskId
POST   /api/goals/:goalId/tasks
POST   /api/goals/:goalId/tasks/:taskId/skip
POST   /api/goals/:goalId/roadmap/reorder

POST   /api/goals/:goalId/resume
POST   /api/goals/:goalId/tasks/:taskId/retry
POST   /api/goals/:goalId/approvals/:approvalId/approve
POST   /api/goals/:goalId/approvals/:approvalId/reject

GET    /api/goals/:goalId/metrics
GET    /api/goals/:goalId/sessions
```

最终 URL 可根据当前 Server 路由约定调整。所有修改接口都必须：运行时校验、事务更新、权限/状态检查、幂等处理、
审计事件和稳定错误码。

### 7.2 V1 WebSocket 事件

- `goal.instruction.received/applied/rejected`
- `goal.roadmap.revised`
- `goal.recovery.started/resolved/needs_human`
- `goal.approval.requested/resolved`
- `goal.budget.warning/exceeded`
- `goal.metrics.updated`
- `goal.notification.created`

实时事件只承载通知和投影所需数据；页面重连后必须通过 HTTP 读取数据库快照恢复，不能依赖补齐全部 WebSocket 历史。

## 8. 里程碑与依赖顺序

```text
Phase 0  基线与决策冻结
   ↓
Phase 1  V1 领域模型、迁移与历史查询
   ↓
Phase 2  租约、恢复、Resume/Retry 与幂等控制
   ↓
Phase 3  Human Instruction / Give Instruction / Continue
   ↓
Phase 4  Roadmap Revision 与安全编辑
   ↓
Phase 5  Execution Memory / Working Set 增强
   ↓
Phase 6  风险、审批、权限与预算
   ↓
Phase 7  Progress / ETA / Reliability Metrics
   ↓
Phase 8  Orchestrator 通知
   ↓
Phase 9  Agent Control Center UI/UX
   ↓
Phase 10 Claude/Codex Worker Runtime 一致性加固
   ↓
Phase 11 故障注入、真实任务、性能与长期稳定性验收
   ↓
Phase 12 文档、迁移说明与 V1 Release Gate
```

Phase 2 是后续所有可变更控制面的安全基础；在恢复和幂等未通过前，不开始路线图编辑。Phase 9 在各后端能力有稳定
API 后集中完成，避免前端先行固化不可靠语义。

## 9. 逐阶段、逐 Step 实施计划

每个 Step 完成后创建一个独立本地提交；不推送远程。提交前至少运行该 Step 的定向测试与 `git diff --check`。
每个 Phase 结束后运行相关 workspace 的 typecheck/test，跨包 Phase 再运行 lint。

### Phase 0 — 基线冻结与规格对齐

#### Step 0.1 — 建立 V0→V1 能力矩阵

- 工作：逐项核对现有 storage、orchestrator、server、CLI、Dashboard 和测试，标注“已完成、部分完成、未完成”。
- 产物：更新实施地图，列出复用点、差距、数据迁移影响和 Monitor 回归风险。
- 验收：每项 V1 能力都能映射到现有模块或明确的新模块；不得把已有能力重复实现一遍。
- 测试：只做只读检查和现有基线门禁抽样。
- 建议提交：`docs(orchestrator): map v1 capabilities to current architecture`

#### Step 0.2 — 冻结 V1 状态与安全语义

- 工作：为 Instruction、RoadmapRevision、Approval、Lease、Retry/Resume 编写状态图和非法迁移表。
- 产物：ADR 或协议文档，明确 safe boundary、SKIPPED、NEEDS_HUMAN、幂等键和冲突返回。
- 验收：不存在“编辑即完成”“重试覆盖旧 Attempt”“恢复盲目重启”等模糊语义。
- 测试：用表驱动示例审查每个允许/拒绝路径。
- 建议提交：`docs(orchestrator): define v1 control and recovery semantics`

#### Step 0.3 — 建立 V1 测试夹具和兼容基线

- 工作：准备历史 Goal、活动 Goal、旧 migration 数据、崩溃 Attempt、待审批、路线图冲突等确定性 fixture。
- 产物：测试工厂和不会访问真实密钥/网络的临时 workspace fixture。
- 验收：fixture 可重复创建、互不污染，并能覆盖旧 V0 数据升级。
- 测试：fixture 自测；记录当前 Monitor 与 Orchestrator 基线测试数量。
- 建议提交：`test(orchestrator): add v1 state and migration fixtures`

### Phase 1 — V1 领域模型、持久化与 Goal 历史

#### Step 1.1 — 添加 V1 additive migration

- 工作：新增 Instruction、RoadmapRevision、MemorySnapshot、Approval、Lease、Metric、Notification 所需结构、索引和外键。
- 产物：只向前追加的 SQLite migration 与 schema 类型。
- 验收：全新数据库和从 V0 数据库升级均成功；旧 Goal/Session 可读取；外键与唯一约束生效。
- 测试：migration from empty、migration from V0、rollback-free reopen、cascade/retain 行为。
- 建议提交：`feat(storage): add orchestrator v1 persistence schema`

#### Step 1.2 — 实现 V1 repositories 与事务边界

- 工作：实现新增实体的 create/get/list/transition，并提供路线图修订、审批和控制命令的原子事务。
- 产物：storage repository API；Orchestrator 不直接拼 SQL。
- 验收：并发 revision 冲突、重复 idempotency key、非法状态转换均被确定性拒绝。
- 测试：repository 单元测试、并发事务测试、外键与索引查询测试。
- 建议提交：`feat(storage): add v1 orchestrator repositories`

#### Step 1.3 — 完善 Goal 历史查询

- 工作：增加稳定 cursor 分页、状态/provider/workspace 筛选、标题/Goal 文本搜索和默认时间排序。
- 产物：History query service 与稳定 API DTO。
- 验收：分页无重复/漏项；活动与历史 Goal 可区分；查询不加载完整 Attempt/Event 大对象。
- 测试：边界页、空结果、多条件组合、相同时间戳稳定排序。
- 建议提交：`feat(orchestrator): add paginated goal history queries`

#### Step 1.4 — 增加 Goal 归档语义

- 工作：实现已结束或 PAUSED Goal 的 archive/unarchive；活动 Goal 禁止归档。
- 产物：归档字段、服务方法、审计事件；默认列表隐藏已归档 Goal。
- 验收：归档不删除 Task/Attempt/Verification/Session；可恢复显示；重复调用幂等。
- 测试：状态限制、历史保留、筛选和幂等测试。
- 建议提交：`feat(orchestrator): add safe goal archiving`

### Phase 2 — 恢复、Resume/Retry 与幂等控制

#### Step 2.1 — 实现 GoalRunLease

- 工作：在启动 Goal/Attempt 前原子获取带 generation 的租约，运行中 heartbeat，正常/异常结束释放。
- 产物：Lease Manager 与超时配置；数据库约束继续作为第二道防线。
- 验收：两个进程不能同时驱动同一 Goal；过期租约不能覆盖新 generation；关闭后无永久死锁。
- 测试：多实例竞争、heartbeat、过期接管、旧 owner 延迟写入隔离。
- 建议提交：`feat(orchestrator): fence goal execution with durable leases`

#### Step 2.2 — 建立 Recovery Classifier

- 工作：综合 Goal/Task/Attempt 状态、Session 状态、进程证据、租约和最后事件，将恢复分类为安全继续、仍在运行、
  可重试、需要人工或已终止。
- 产物：纯函数分类器、原因码和用户可读解释。
- 验收：未知状态永远不会被推断为成功；仍存活 Attempt 不会被重复启动。
- 测试：状态矩阵、缺失证据、过期进程、Session 与 Attempt 冲突。
- 建议提交：`feat(orchestrator): classify interrupted goal recovery`

#### Step 2.3 — 实现安全 Resume

- 工作：从最后一个已验证 Task 或明确的失败边界恢复；重新采集 Project State 和 Working Set 后再规划。
- 产物：Resume command、事件与结果 DTO。
- 验收：Resume 不跳过未验证 Task；LOCKED 约束保留；恢复后仍只有一个活动 Attempt。
- 测试：PAUSED、NEEDS_HUMAN、crashed、already-running、completed/aborted 拒绝路径。
- 建议提交：`feat(orchestrator): resume goals from verified boundaries`

#### Step 2.4 — 实现显式 Retry

- 工作：允许对合适的失败/不确定 Task 创建新 Attempt，携带上次 Verification evidence 和修复目标。
- 产物：Retry service、attempt numbering 和 retry reason。
- 验收：旧 Attempt 不可变；不超过 maxAttempts/预算；不可对 COMPLETED Task 随意重试。
- 测试：次数边界、并发重复请求、证据传递、超限进入 NEEDS_HUMAN。
- 建议提交：`feat(orchestrator): add evidence-backed task retry`

#### Step 2.5 — 为控制命令增加幂等与乐观并发

- 工作：Start/Pause/Continue/Resume/Retry/Abort/Instruction/Roadmap edit 接收 idempotency key 和 expected revision。
- 产物：统一 command envelope、冲突错误码和重复请求结果缓存。
- 验收：双击、网络重试和 WebSocket 重连不会产生双 Attempt 或双 revision。
- 测试：同 key 同 payload、同 key 不同 payload、过期 revision、并发控制命令。
- 建议提交：`feat(server): make orchestrator controls idempotent`

### Phase 3 — Human Instruction、Give Instruction 与 Continue

#### Step 3.1 — 定义并持久化 Instruction

- 工作：支持 clarification、constraint、priority、approval-context、general 五类指令；保存来源和 base revision。
- 产物：Instruction service、schema validation、列表查询和事件。
- 验收：空内容、超长内容、失效 Goal 和非法 kind 被拒绝；敏感内容不进入普通日志。
- 测试：创建、查询、校验、审计和序列化测试。
- 建议提交：`feat(orchestrator): persist human instructions`

#### Step 3.2 — 实现 Instruction Applicability Validator

- 工作：判断指令是否与 LOCKED 约束冲突、是否要求高风险动作、是否基于过期 roadmap revision。
- 产物：APPLY/REJECT/NEEDS_APPROVAL/NEEDS_CLARIFICATION 决策与原因码。
- 验收：普通指令不能静默推翻原始 Goal 或已锁定决策。
- 测试：约束冲突、过期 revision、重复和 supersede 场景。
- 建议提交：`feat(orchestrator): validate instruction applicability`

#### Step 3.3 — 在安全边界应用 Instruction

- 工作：Attempt 运行期间只入队；Attempt 结束、Pause 或 NEEDS_HUMAN 后更新 Memory/Working Set，并触发 rolling planning。
- 产物：Instruction application pipeline 和 applied revision 引用。
- 验收：已启动 Worker prompt 不被暗中篡改；下一 Task Contract 明确反映已应用指令。
- 测试：运行中排队、边界应用、多指令顺序、应用失败回滚。
- 建议提交：`feat(orchestrator): apply instructions at task boundaries`

#### Step 3.4 — 明确 Give Instruction / Continue 行为

- 工作：`Give Instruction` 只提交指令；`Continue` 在已有可应用指令时先应用再恢复，否则按原计划恢复。
- 产物：统一服务命令、CLI/API 返回状态和 Dashboard 文案。
- 验收：按钮行为不含隐式高风险动作；Continue 不绕过未解决 Approval 或 critical UNCERTAIN。
- 测试：有/无指令、PAUSED/NEEDS_HUMAN、待审批、重复请求。
- 建议提交：`feat(orchestrator): add instruction-aware continue flow`

#### Step 3.5 — CLI 人工指令入口

- 工作：增加 list/show/instruct/continue 命令参数，并调用 Server/Core 的同一服务。
- 产物：非交互 CLI 命令、JSON/人类可读输出、明确 exit code。
- 验收：CLI 不直接改数据库；Server 不可用时给出可操作错误；Unicode/多行输入不乱码。
- 测试：参数解析、API mock、错误码、PowerShell/WSL 字符输入 fixture。
- 建议提交：`feat(cli): add orchestrator instruction controls`

### Phase 4 — Roadmap Revision 与安全编辑

#### Step 4.1 — 建立 RoadmapRevision 快照

- 工作：初始规划和每次 rolling planning 都生成 revision，记录 source、reason、前后差异和 active revision。
- 产物：revision builder、diff、查询 API。
- 验收：任意时间点可解释某 Task 为什么出现、移动、变化或被跳过。
- 测试：初始、无变化、插入、重排、跳过和 Planner revision。
- 建议提交：`feat(orchestrator): version roadmap changes`

#### Step 4.2 — 编辑未来 Task Contract

- 工作：允许修改未开始 Task 的 title/objective/criteria/verification/constraints/maxAttempts，执行完整校验。
- 产物：patch command 与新 revision。
- 验收：不能清空验收标准、放宽 LOCKED 约束或修改历史 Task；冲突时不部分写入。
- 测试：合法 patch、字段校验、状态限制、revision conflict。
- 建议提交：`feat(orchestrator): edit future task contracts safely`

#### Step 4.3 — 插入 Task

- 工作：在指定未来位置插入完整 Task Contract，默认由用户锁定或显式标记 tentative。
- 产物：insert command、序号重算和 revision event。
- 验收：插入不会改变已执行顺序；新增 Task 必须能被 Verifier 验收。
- 测试：首/中/尾插入、序号冲突、活动边界、非法 contract。
- 建议提交：`feat(orchestrator): insert roadmap tasks`

#### Step 4.4 — 跳过未来 Task

- 工作：把 UI 的“删除 Task”实现为带原因的 `SKIPPED`，并检查是否覆盖原始 Goal requirement。
- 产物：skip command、影响分析和必要时的 NEEDS_HUMAN。
- 验收：不能物理删除审计历史；跳过关键 requirement 不能让 Goal 错误完成。
- 测试：普通 tentative Task、LOCKED requirement、当前/已完成 Task 拒绝。
- 建议提交：`feat(orchestrator): skip future tasks with audit history`

#### Step 4.5 — 重排未来 Task

- 工作：一次提交完整未开始 Task 顺序；校验集合一致、无重复/遗漏，并创建 revision。
- 产物：reorder command 与确定性 sequence 更新。
- 验收：当前 Task 和历史 Task 位置不变；并发重排只有一个成功。
- 测试：正常、重复 ID、缺失 ID、过期 revision、并发冲突。
- 建议提交：`feat(orchestrator): reorder pending roadmap tasks`

#### Step 4.6 — Planner 与人工 revision 合并规则

- 工作：Planner 必须继承用户锁定修改；只能变更 tentative 区域；冲突时输出 NEEDS_HUMAN 而非覆盖。
- 产物：revision merge policy 和 change reason。
- 验收：人工优先级/约束不会在下一轮 rolling plan 中消失。
- 测试：无冲突合并、同 Task 冲突、用户锁定、Planner 删除关键 Task。
- 建议提交：`feat(orchestrator): preserve user roadmap revisions during planning`

### Phase 5 — Execution Memory 与 Working Set 增强

#### Step 5.1 — 版本化 Execution Memory

- 工作：保存 goalSummary、LOCKED/STABLE/TENTATIVE decisions、completed task summaries、issues、questions 与来源引用。
- 产物：MemorySnapshot builder 和 active revision。
- 验收：每个重要决策可追溯到用户指令、Task、Verification 或代码证据。
- 测试：版本递增、来源完整、旧 snapshot 可读取、敏感字段过滤。
- 建议提交：`feat(orchestrator): version execution memory snapshots`

#### Step 5.2 — 每个安全边界刷新 Project State

- 工作：Task/Attempt/Instruction/Resume 后重新采集 Git、相关文件、验证状态和最近变化。
- 产物：边界刷新 pipeline 与变更摘要。
- 验收：Planner 不使用启动时陈旧状态继续规划；采集器保持只读。
- 测试：文件变化、Git 变化、无 Git、命令不可用、重复采集稳定性。
- 建议提交：`feat(orchestrator): refresh project state at control boundaries`

#### Step 5.3 — 增量更新 Working Set

- 工作：根据 Goal、当前 Task、changed files、失败证据和符号搜索增删相关文件；设置数量/大小上限。
- 产物：Working Set scorer、去重和淘汰原因。
- 验收：不盲目把全仓库塞入上下文；关键失败文件不会被过早淘汰。
- 测试：相关性、上限、敏感路径、删除文件、monorepo 路径。
- 建议提交：`feat(orchestrator): maintain a bounded working set`

#### Step 5.4 — Memory 压缩与漂移保护

- 工作：在阈值触发时压缩已完成 Task，但保留 LOCKED 决策、未解决问题、验证失败和来源 ID。
- 产物：确定性压缩器；可选 Provider 摘要必须经过 schema 校验。
- 验收：压缩前后约束和未决问题等价；原始历史仍在数据库。
- 测试：长序列、重复信息、锁定项、压缩失败 fallback。
- 建议提交：`feat(orchestrator): compact execution memory safely`

#### Step 5.5 — 强化 Rolling Planner 输入与输出审计

- 工作：Planner 输入只包含选定状态/Memory/Working Set/evidence；输出记录 action、理由、变更 diff 和 confidence。
- 产物：版本化 planner input/output envelope。
- 验收：Planner 信息不足时选择 INSPECT/NEEDS_HUMAN，不臆造仓库事实。
- 测试：继续、检查、重规划、最终验证、缺失信息和非法输出。
- 建议提交：`feat(orchestrator): audit rolling planner decisions`

### Phase 6 — 风险、审批、权限与预算

#### Step 6.1 — 建立统一风险分类

- 工作：把动作分为 read、workspace-write、process、network、secret、destructive、remote-side-effect 等类别与等级。
- 产物：RiskAssessment、原因码和默认 conservative policy。
- 验收：删除、覆盖、push/deploy、外部写入和密钥请求不会被误判为普通低风险动作。
- 测试：动作矩阵、未知动作默认升级、平台差异。
- 建议提交：`feat(orchestrator): classify task execution risk`

#### Step 6.2 — 实现 ApprovalRequest

- 工作：高风险 Task 在启动 Worker 前创建审批；approve/reject/expire 均持久化并驱动明确状态。
- 产物：Approval service、API、事件和审计记录。
- 验收：无审批不能启动；批准只适用于精确 action/scope/revision，不成为永久通配权限。
- 测试：批准、拒绝、过期、重复、范围变化、恢复中的待审批。
- 建议提交：`feat(orchestrator): gate risky actions on approval`

#### Step 6.3 — 增加运行预算

- 工作：支持 Goal/Task 的最大尝试、最大墙钟时间、可用时的 token/cost 警戒线和硬上限。
- 产物：Budget policy、warning/exceeded 事件和停止原因。
- 验收：数据不可用时不伪造 token/cost；硬上限触发安全暂停/NEEDS_HUMAN，不无限运行。
- 测试：尝试、时间、provider usage 缺失、软/硬阈值、恢复后累计。
- 建议提交：`feat(orchestrator): enforce bounded execution budgets`

#### Step 6.4 — 映射 Provider 权限能力

- 工作：把统一 Risk Policy 映射到 Claude/Codex runner 的已支持权限选项；不支持的能力明确降级或需人工。
- 产物：Provider capability/preflight result。
- 验收：不通过危险全局 flag 绕过审批；Provider 不支持细粒度控制时界面如实显示限制。
- 测试：Claude/Codex capability fixture、缺失 CLI、版本差异、fallback。
- 建议提交：`feat(orchestrator): map risk policy to provider capabilities`

#### Step 6.5 — 密钥与日志边界加固

- 工作：Instruction、Worker input/result、错误和事件统一执行 secret redaction；环境变量值不落库。
- 产物：共享 redaction policy 与安全测试样本。
- 验收：常见 API key、Bearer、`.env` 内容和命令行 secret 不出现在日志、事件、Dashboard。
- 测试：编码/分隔符变体、Unicode、嵌套对象、误报控制。
- 建议提交：`fix(orchestrator): harden secret redaction boundaries`

### Phase 7 — Progress、ETA 与可靠性指标

#### Step 7.1 — 实现 Orchestrator Goal Progress

- 工作：根据已验证 Task 权重、当前阶段、剩余 locked/tentative Task 和最终验证计算 progress/value/confidence/reasons。
- 产物：GoalProgressSnapshot；完成状态固定为 100%，最终验证前上限小于 100%。
- 验收：小任务完成后不长期停在 60%；失败/新增 Gap Task 时可解释地调整；不假装精确。
- 测试：单 Task、多 Task、repair、gap、skip、completed、needs human。
- 建议提交：`feat(orchestrator): compute evidence-based goal progress`

#### Step 7.2 — 实现 Task Progress

- 工作：按 planning/working/verifying/repairing/completed 阶段投影当前 Task，并优先使用真实事件/验证证据。
- 产物：TaskProgressSnapshot 与阶段原因。
- 验收：Task completed 必为 100%；无事件时显示低置信度而不是伪造细粒度变化。
- 测试：阶段转换、provider 无结构事件、重试、暂停和异常结束。
- 建议提交：`feat(orchestrator): project task progress from lifecycle evidence`

#### Step 7.3 — 建立 ETA range 与冷启动策略

- 工作：按 workspace/provider/task type/verification profile 聚合本地历史；样本不足时使用当前 Goal 观测与宽区间。
- 产物：remaining range、confidence、sampleCount、reasons；允许 Unavailable。
- 验收：少量历史不会产生高置信度单点 ETA；完成/暂停时语义正确；异常长任务不污染全部基线。
- 测试：0/1/少量/充足样本、离群值、repair、gap、provider 变化。
- 建议提交：`feat(orchestrator): estimate eta with confidence ranges`

#### Step 7.4 — 聚合 V1 可靠性指标

- 工作：计算 Task Success Rate、Average Repair Attempts、Human Intervention Rate、Runtime、可用时 token/cost、
  False Completion Rate proxy。
- 产物：本地指标查询与清晰定义文档。
- 验收：False Completion 以“完成后 final gate/回归失败或重新生成 gap”为证据，不凭主观标签；分母为零时明确 N/A。
- 测试：指标 fixture、时间范围、归档 Goal、缺失 usage。
- 建议提交：`feat(orchestrator): expose v1 reliability metrics`

#### Step 7.5 — 持久化与广播 Metric Snapshot

- 工作：只在状态/区间发生实质变化或节流周期到达时保存/广播，避免事件风暴。
- 产物：snapshot policy、WebSocket event、API DTO。
- 验收：重启后投影可恢复；实时更新不重复；Dashboard 不依赖前端自行推算。
- 测试：去重、节流、重连、旧 snapshot 兼容。
- 建议提交：`feat(orchestrator): persist and stream metric snapshots`

### Phase 8 — Orchestrator 通知

#### Step 8.1 — 定义关键通知策略

- 工作：覆盖 NEEDS_HUMAN、Approval、预算预警/超限、Goal completed/failed、恢复失败；普通 progress 不通知。
- 产物：Notification rule 与 eventKey。
- 验收：同一状态重放不会重复弹通知；恢复/重连不会制造噪音。
- 测试：规则矩阵、去重、状态反复、归档 Goal。
- 建议提交：`feat(orchestrator): generate actionable goal notifications`

#### Step 8.2 — 复用浏览器通知与偏好

- 工作：接入现有 Dashboard notification 能力，增加 Orchestrator 类别、静音和仅失败/需人工选项。
- 产物：通知偏好与页面内 fallback 提示。
- 验收：权限拒绝/不支持时页面功能正常；默认不发送外部服务通知。
- 测试：permission 状态、偏好、后台 tab、WebSocket 重连。
- 建议提交：`feat(dashboard): notify on orchestrator attention events`

#### Step 8.3 — 通知中心与已读状态

- 工作：增加最近通知列表、关联 Goal/Task 跳转和 read/dismiss 状态。
- 产物：轻量通知中心；历史由数据库提供。
- 验收：点击可到达正确上下文；已读同步且幂等；不泄露隐藏/归档内容摘要。
- 测试：分页、跳转、已读、归档、删除 Session 引用缺失。
- 建议提交：`feat(dashboard): add orchestrator notification center`

### Phase 9 — Agent Control Center UI/UX

#### Step 9.1 — Goal History 页面

- 工作：增加分页、搜索、状态/provider/workspace 筛选、活动/历史/归档分区和空状态。
- 产物：History UI 与 URL 查询状态。
- 验收：刷新和前进/后退保留筛选；大历史列表不一次加载全部详情。
- 测试：组件、API、分页、键盘导航和错误恢复。
- 建议提交：`feat(dashboard): add searchable goal history`

#### Step 9.2 — Goal/Task/Attempt/Session 导航

- 工作：从 Goal 到当前/历史 Task、Attempt、Verification 和 AgentScope Session；Session 也显示关联 Goal。
- 产物：稳定深链接、面包屑和缺失引用 fallback。
- 验收：刷新深链接可恢复；旧 Session/Goal 缺失关联时不 404 崩溃。
- 测试：路由、历史、缺失数据和跨页返回。
- 建议提交：`feat(dashboard): link goals tasks attempts and sessions`

#### Step 9.3 — Human Instruction 控件

- 工作：提供输入、类型、作用 revision、待应用状态、冲突原因和 Continue 组合操作。
- 产物：Give Instruction 面板与 pending/applied/rejected 历史。
- 验收：运行中明确提示“将在安全边界应用”；发送中禁重复；错误不丢输入。
- 测试：正常、冲突、离线、重复、Unicode/多行、屏幕阅读器标签。
- 建议提交：`feat(dashboard): add human instruction controls`

#### Step 9.4 — Roadmap 编辑器

- 工作：支持编辑未来 Task、插入、跳过、重排，展示 revision diff 并在提交前确认影响。
- 产物：非自由拖拽优先的保守表单；可在稳定后增加拖拽。
- 验收：运行中 Task 与历史 Task 不出现危险编辑按钮；冲突后重新载入而非覆盖。
- 测试：权限/状态、表单校验、revision conflict、键盘重排。
- 建议提交：`feat(dashboard): add revision-safe roadmap editing`

#### Step 9.5 — Recovery、Retry 与 Approval 面板

- 工作：显示为什么暂停、可用安全动作、旧 Attempt 证据、风险范围和审批到期时间。
- 产物：恢复决策卡、Retry/Resume/Approve/Reject 控件。
- 验收：用户能区分 Continue、Resume、Retry；不可用操作不显示或给出明确原因。
- 测试：所有状态矩阵、双击幂等、过期数据、错误反馈。
- 建议提交：`feat(dashboard): add recovery and approval controls`

#### Step 9.6 — Progress、ETA、Memory 与变更解释

- 工作：展示 value/range/confidence/reasons/sampleCount、当前 Memory 决策和 roadmap revision 原因。
- 产物：可展开解释，不用颜色作为唯一信息来源。
- 验收：Unavailable/低置信度语义清楚；completed 必为 100%；新增 Gap Task 有解释。
- 测试：快照、响应式布局、长文本、无历史样本、状态变化。
- 建议提交：`feat(dashboard): explain orchestrator progress eta and decisions`

#### Step 9.7 — UX、可访问性与异常恢复

- 工作：补充 loading/empty/error/offline/reconnecting、焦点管理、确认对话框、窄屏布局和减少动画。
- 产物：统一 Control Center UI 状态组件。
- 验收：Server 重启后页面自动恢复；关键控制可仅键盘完成；危险操作需要明确确认。
- 测试：可访问性检查、断线、404/409/500、刷新、不同视口。
- 建议提交：`fix(dashboard): harden control center interaction states`

### Phase 10 — Claude/Codex Worker Runtime 一致性加固

#### Step 10.1 — 冻结 Worker capability matrix

- 工作：对当前安装版本实测 Claude/Codex 的 structured、session、usage、tool/file/command event、permission 和中断能力。
- 产物：版本化 capability fixture 与文档；未知能力不得猜测。
- 验收：Orchestrator 根据 capability 降级；CLI 更新不会静默改变安全策略。
- 测试：fixture parser、缺失/新增字段、版本差异。
- 建议提交：`docs(orchestrator): record worker capability matrix`

#### Step 10.2 — 统一 Worker Result 与失败分类

- 工作：把 provider exit、auth、rate limit、network、permission、invalid output、user interrupt 映射为统一结果。
- 产物：错误 taxonomy、retryable 标志和原始诊断引用。
- 验收：rate limit 可按有界退避重试；认证/权限错误直接 NEEDS_HUMAN；错误不被当作 claimed completed。
- 测试：Claude/Codex fixture、乱码/截断输出、无输出退出、并发限制。
- 建议提交：`feat(orchestrator): normalize worker failures across providers`

#### Step 10.3 — 加固 Attempt↔Session↔Evidence 关联

- 工作：确保创建、运行、恢复、重试和异常收尾都保存稳定关联，事件可回溯到 Task/Attempt。
- 产物：关联完整性检查与修复诊断，不自动篡改历史。
- 验收：Dashboard 从 Attempt 可到 Session；重试不会串用上一 Attempt 的证据。
- 测试：正常、启动失败、Session 晚到、恢复、多个历史 Attempt。
- 建议提交：`fix(orchestrator): harden worker session evidence links`

#### Step 10.4 — Provider 退避与取消

- 工作：对明确 retryable 错误做有上限、可取消、带 jitter 的退避；Pause/Abort/预算超限中止等待。
- 产物：Retry policy 与 timer abstraction。
- 验收：不会无限等待或绕过 maxAttempts；恢复后不会重复安排多个 timer。
- 测试：虚拟时钟、取消、上限、非 retryable、进程重启。
- 建议提交：`feat(orchestrator): bound provider retry backoff`

### Phase 11 — 验证、故障注入与真实任务验收

#### Step 11.1 — V1 单元与属性测试闭环

- 工作：补齐所有状态机、revision、幂等、lease、risk、budget、progress/ETA 和 memory 的边界测试。
- 产物：无网络确定性测试套件。
- 验收：非法状态、重复请求、过期 generation/revision、空历史与异常输入均有覆盖。
- 测试：相关 package 全量 test/typecheck。
- 建议提交：`test(orchestrator): complete v1 state coverage`

#### Step 11.2 — Core/Storage/Server 集成测试

- 工作：在临时数据库和 workspace 串起 create→instruction→revision→attempt→verify→retry/resume→complete。
- 产物：跨包集成测试。
- 验收：进程重建后状态一致；WebSocket 丢失不影响 HTTP 快照；Monitor Session 仍可正常使用。
- 测试：integration suite、server route tests、migration tests。
- 建议提交：`test(orchestrator): add v1 control loop integration coverage`

#### Step 11.3 — 故障注入与恢复矩阵

- 工作：在 planning、worker start、worker running、verification、revision write、notification 各点模拟崩溃。
- 产物：恢复矩阵与自动 fault-injection tests。
- 验收：不出现双 Attempt、虚假完成、丢失用户指令或半个 roadmap revision。
- 测试：重复启动、DB busy、进程消失、Server 重启、WebSocket 断线。
- 建议提交：`test(orchestrator): verify crash recovery invariants`

#### Step 11.4 — 真实 Claude/Codex 安全任务

- 工作：分别运行只读任务、短文件修改+验证、验证失败后修复、Pause/Instruction/Continue 和 Provider 临时失败。
- 产物：不含密钥的验收记录、Session/Attempt/Verification ID 和结果摘要。
- 验收：两个 Provider 均遵守单 Task contract；完成有证据；失败正确分类；不要求用户反复输入“继续”。
- 测试：真实 CLI；凭据只从 gitignored 环境配置或用户环境读取。
- 建议提交：`test(orchestrator): record v1 real-provider acceptance`

#### Step 11.5 — Progress/ETA 冷启动与历史校准验收

- 工作：用合成历史和多次安全任务验证 0/少量/充足样本下的 range、confidence 和完成进度。
- 产物：基线报告与可接受误差定义。
- 验收：样本不足时保守；任务结束为 100%；实际超出 ETA 时区间/置信度可更新。
- 测试：统计 fixture、真实短任务观察、不比较伪精确单点。
- 建议提交：`test(orchestrator): validate progress and eta calibration`

#### Step 11.6 — 性能与长期稳定性

- 工作：构造大量历史 Goal/Task/Event，测分页、详情、广播、内存、CPU、DB 大小；运行数小时串行 mock Goal。
- 产物：P50/P95、资源曲线和容量上限记录。
- 验收：历史增长不导致首页加载全部数据；无明显 listener/timer/lease 泄漏；DB 查询使用索引。
- 测试：本地 benchmark 和 soak test；阈值以现有 V0 基线为比较对象。
- 建议提交：`test(orchestrator): add v1 performance and soak baselines`

#### Step 11.7 — Monitor 与跨平台回归

- 工作：回归 Windows/WSL2，条件允许时 macOS；验证 Claude/Codex TTY、structured、app-server、session 删除/隐藏、通知。
- 产物：兼容矩阵和已知限制。
- 验收：V1 不破坏原有 Monitor 启动、实时广播、恢复、TTY 输入、Unicode 路径和 Dashboard。
- 测试：`pnpm release:check` 及平台 smoke。
- 建议提交：`test(orchestrator): verify monitor and platform compatibility`

### Phase 12 — 文档、迁移与 V1 发布准备

#### Step 12.1 — 更新用户使用说明

- 工作：用中文说明创建 Goal、Give Instruction、Continue/Resume/Retry、编辑路线图、审批、归档和历史查询。
- 产物：可复制的 Windows/WSL2 命令、Dashboard 操作和预期结果。
- 验收：新用户无需理解内部状态机也能安全使用；高风险动作有醒目提示。
- 测试：按文档从干净环境走一遍 happy path 和 recovery path。
- 建议提交：`docs(orchestrator): add v1 user guide`

#### Step 12.2 — 更新运维与迁移说明

- 工作：说明数据库备份、migration、恢复诊断、lease 清理原则、日志和通知权限。
- 产物：V0→V1 升级与故障排查文档。
- 验收：不要求用户手工改 SQLite；失败时有可回滚到备份的流程。
- 测试：复制 V0 DB 后升级和读取；文档命令 smoke。
- 建议提交：`docs(orchestrator): document v1 migration and recovery`

#### Step 12.3 — 冻结 V1 capability/known issues

- 工作：记录 Claude/Codex 能力差异、ETA 冷启动、Provider 权限限制和 V2 deferred items。
- 产物：Capability Matrix、Known Issues、Release Notes。
- 验收：Unavailable 明确写出；不把 V2 能力包装成 V1 已支持。
- 测试：文档链接与示例校验。
- 建议提交：`docs(orchestrator): publish v1 capabilities and known issues`

#### Step 12.4 — 执行 V1 Release Gate（已完成）

- 工作：运行 format、lint、typecheck、unit、integration、build、migration、fault injection、real-provider smoke 和安全审查。
- 产物：[`docs/findings/v1-release-gate.md`](findings/v1-release-gate.md) 最终本地验收记录和测试计数。
- 验收：已通过；已知平台/容量边界均在矩阵中标记，未把未执行项当作通过。
- 测试：`pnpm release:check` 通过（88 个测试文件/478 项单元测试、5 个集成文件/17 项集成测试），V1 专项验收和 `pnpm audit --prod` 通过。
- 建议提交：`chore(orchestrator): prepare v1 release`

## 10. 每个 Step 的统一完成定义

一个 Step 只有同时满足以下条件才可以提交：

- 行为与本文及上游规格一致，没有偷偷扩大到 V2。
- 新增或变化的状态有运行时 schema、显式迁移和稳定错误语义。
- 关键逻辑有自动测试，失败路径与成功路径都覆盖。
- 未破坏 V0 Orchestrator 与 Monitor 的现有测试。
- 用户可见行为已同步文档或在后续文档 Step 有明确追踪。
- 日志/事件不包含密钥或不必要的用户输入原文。
- `git diff --check` 与定向 typecheck/test 通过。
- 只包含当前功能点相关修改，创建一个清晰的本地提交。

## 11. V1 验收矩阵

| 编号 | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| V1-A01 | 创建并执行多 Task Goal | 无需反复输入“继续”，单 Worker 串行完成并最终独立验证 |
| V1-A02 | Worker 自报完成但测试失败 | Task 不得完成，进入 repair/retry 或 NEEDS_HUMAN |
| V1-A03 | 运行中提交 Instruction | 指令显示 PENDING，并仅在安全边界应用 |
| V1-A04 | Instruction 冲突 LOCKED 约束 | 明确拒绝/请求人工，不静默覆盖 |
| V1-A05 | 编辑未来 Task | 产生新 roadmap revision，历史 revision 可查看 |
| V1-A06 | 跳过关键 Task | Goal final verification 发现缺口，不得错误完成 |
| V1-A07 | 双击 Continue/Retry | 只产生一个控制结果和一个新 Attempt |
| V1-A08 | Server 在 Worker 运行中崩溃 | 重启后不重复启动；无法确认时 NEEDS_HUMAN |
| V1-A09 | Provider rate limit/network error | 有界退避或可解释暂停，不无限重试 |
| V1-A10 | 认证/权限/密钥失败 | 直接请求人工，敏感值不落库/日志 |
| V1-A11 | 高风险动作 | Worker 启动前出现精确范围 Approval，未批准不执行 |
| V1-A12 | 超过时间/尝试预算 | 安全停止并说明原因 |
| V1-A13 | 单个小 Task 完成 | Task 进度 100%，Goal 是否 100% 取决于 final verification |
| V1-A14 | ETA 无历史样本 | 显示 Unavailable 或低置信度宽区间，不伪造精确值 |
| V1-A15 | ETA 历史逐渐增加 | sampleCount/confidence 和区间按规则更新 |
| V1-A16 | Goal 历史很多 | 分页、筛选、搜索稳定，无重复/漏项 |
| V1-A17 | 归档 Goal | 默认列表隐藏但数据与关联 Session 完整，可恢复显示 |
| V1-A18 | WebSocket 断线重连 | HTTP 快照恢复正确，不重复 timeline/notification |
| V1-A19 | V0 数据库升级 | 原 Goal、Session、Attempt、Verification 仍可读取 |
| V1-A20 | Claude 与 Codex Worker | 统一状态语义，能力差异如实降级 |
| V1-A21 | Windows/WSL2 Unicode workspace | 路径、指令、输出和 Dashboard 不乱码 |
| V1-A22 | 原 Monitor TTY/structured/app-server | 行为与 V1 之前兼容 |
| V1-A23 | Goal 最终完成 | 100% progress、final verification PASS、证据可追溯 |
| V1-A24 | False completion 回归集 | 所有缺证据/缺 requirement 场景均不能完成 |

## 12. 关键指标与发布阈值

V1 发布时至少记录以下指标；没有足够真实样本时可以不设置产品承诺，但必须保证计算定义稳定：

- False Completion Rate：最高优先级，确定性回归集目标为 0。
- Task Success Rate：区分首次成功与 repair 后成功。
- Average Repair Attempts：同时报告样本数和分布，不能只给平均值。
- Human Intervention Rate：按原因分类为 ambiguity、risk、permission、budget、recovery、uncertain。
- Recovery Safety：故障注入中双 Attempt 和静默丢指令目标为 0。
- Control Idempotency：重复命令产生重复副作用目标为 0。
- Goal/Task Runtime：P50/P95，并按 provider/verification profile 分组。
- ETA：报告 coverage、区间命中率、置信度和 sampleCount，不只报告平均误差。
- Dashboard：历史查询 P50/P95、重连恢复时间和大历史数据量下的响应。
- Token/Cost：只有 Provider 提供可验证 usage 时记录；缺失时不推断。

## 13. 风险与保守应对

| 风险 | 触发信号 | 保守应对 |
| --- | --- | --- |
| 人工指令与运行中 Task 冲突 | 当前 Attempt 已启动 | 入队到下一安全边界；紧急情况要求 Pause/Abort |
| 路线图编辑破坏原始 Goal | 跳过/弱化关键 criterion | 拒绝或 NEEDS_HUMAN；最终验证再次覆盖 |
| Server 重启产生双 Worker | 旧进程/Session 状态不确定 | lease + generation；不确定时不自动接管 |
| Planner 覆盖用户修改 | revision/base revision 不一致 | 乐观并发冲突；用户锁定修改优先 |
| 历史数据不足导致 ETA 误导 | sampleCount 小、任务差异大 | Unavailable 或宽区间 + 低 confidence |
| Provider 能力版本漂移 | CLI 输出/schema 改变 | capability fixture、schema tolerant parser、明确降级 |
| Approval 范围过宽 | action/scope 无法精确描述 | 不批准通配；拆小 Task 或 NEEDS_HUMAN |
| Memory 压缩丢约束 | LOCKED/issue 来源缺失 | 压缩不通过 invariant 时回退旧 snapshot |
| 通知风暴 | 重连/状态重放重复触发 | durable eventKey 去重、节流和用户偏好 |
| V1 破坏 Monitor | TTY/session/WS 回归 | 每个跨包 Phase 跑 Monitor 回归，最终完整 release gate |

## 14. 实施期间默认决策

在文档没有进一步说明时，按以下默认值执行，无需临时扩大范围：

- 一个活动 Goal、一个活动 Task、一个 Worker Attempt。
- 普通指令只在 Task/Attempt 边界应用。
- 未来 Task 的“删除”实现为可审计 `SKIPPED`。
- 已完成 Task/Attempt/Verification 永不原地修改。
- 路线图变更使用乐观并发和 immutable revision。
- 恢复不确定时选择 NEEDS_HUMAN。
- Planner/Verifier Provider 输出必须经 schema 校验；失败回退到保守确定性路径。
- ETA 最少样本不足时宁可 Unavailable，也不显示高置信度单点数字。
- 高风险动作默认需明确审批，Approval 精确绑定 action/scope/revision。
- 浏览器通知复用现有实现，不接第三方通知服务。
- 不保存 API key，不在测试或提交中加入真实密钥。
- 不自动 push、deploy、merge 或执行不可逆操作。

## 15. V1 Definition of Done

Orchestrator V1 只有在以下条件全部满足时才算完成：

- 用户能可靠查看、筛选、搜索和归档持久化 Goal 历史。
- Goal/Task/Attempt/Verification/Session 可双向追踪，历史刷新或重启后不丢失。
- 用户能提交 Human Instruction，并知道它是 pending、applied、rejected 还是 superseded。
- Give Instruction / Continue / Resume / Retry 语义清楚、幂等且不能绕过验证。
- 用户能安全编辑未来路线图、插入 Task、跳过 Task 和重排，并查看 revision 原因与差异。
- Planner 保留 LOCKED 约束和人工修改；上下文不足时不臆造仓库事实。
- Execution Memory 与 Working Set 会在安全边界更新、版本化、压缩且可追溯。
- 高风险动作有审批，预算有上限，密钥不进入数据库、日志或 Dashboard。
- 崩溃恢复不会产生双 Attempt；不确定状态会明确进入 NEEDS_HUMAN。
- Goal/Task progress 在完成时正确为 100%，其他状态包含 confidence/reasons。
- ETA 使用区间、样本数与置信度；无可靠信息时显示 Unavailable。
- NEEDS_HUMAN、Approval、预算和 Goal 终态能够产生去重通知。
- Dashboard 具备完整 Control Center 的历史、控制、解释和异常恢复体验。
- Claude 与 Codex Worker 在统一语义下通过真实安全任务验收。
- False Completion 回归集为 0，所有 V1 验收矩阵项通过。
- Windows/WSL2 与原 Monitor TTY/structured/app-server 路径没有回归。
- migration、format、lint、typecheck、unit、integration、build、fault injection、real-provider smoke 和
  `pnpm release:check` 全部通过。
- Capability Matrix、Known Issues、迁移说明、用户说明和 Release Notes 与实际实现一致。

## 16. 开工顺序

本轮已从 **Step 0.1** 按依赖顺序推进至 Step 12.4。每个功能点均创建独立本地提交，未推送远程；实现细节与当前
架构冲突时采用了最小兼容改动。真实 Provider、WSL2/macOS 和容量边界没有被自动猜测，按矩阵保留后续人工或目标机
验收项。
