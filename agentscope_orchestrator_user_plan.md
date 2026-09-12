# AgentScope Orchestrator 项目需求与路线规划（用户版）

## 1. 项目背景

AgentScope 当前的 Monitor V0 已基本完成：能够对 Claude Code、Codex CLI
等 Coding Agent 的运行过程进行统一观测，并通过 Dashboard 展示 Session
状态、Timeline、Progress / ETA、Git / Files / Process / Test 等证据。

下一阶段的目标，是让 AgentScope 从"观察 Agent"进一步走向"管理 Agent"。

当前人工工作流通常是：

> 用户提出任务 → Coding Agent 执行 → 用户查看结果 → 用户输入"继续下一步"
> → Agent 再执行。

Orchestrator
的核心目标，是自动化中间不断由用户承担的规划、检查和"继续"操作：

> 用户只提供一个较大的 Coding
> Goal，系统自动规划、执行、验证、修复并继续下一步，直到 Goal
> 完成或确实需要人工介入。

长期来看，AgentScope 将从 Agent Monitor 演进为统一的 Agent Control
Center / Control Plane。

------------------------------------------------------------------------

## 2. 产品愿景

最终希望形成如下能力：

``` text
User
 │
 ▼
AgentScope Unified UI
 │
 ├── 输入 Coding Goal
 ├── 查看 Roadmap
 ├── 查看当前 Task
 ├── 查看 Worker 状态
 ├── 查看 Verification
 ├── 查看 Progress / ETA / Timeline
 └── 必要时人工介入
 │
 ▼
Orchestrator
 │
 ├── Planner
 ├── Scheduler / Router
 ├── Worker Runtime
 └── Verifier
 │
 ▼
Claude / Codex / Other Agents
 │
 ▼
AgentScope Observability
```

核心理念：

-   Planner 决定"下一步做什么"。
-   Worker 决定"具体怎么做"。
-   Verifier 决定"是否真的完成"。
-   三者不盲目信任彼此，而通过结构化状态和证据交流。
-   AgentScope 现有 Observability 能力作为整个系统的底座。

------------------------------------------------------------------------

# 3. Orchestrator V0

## 3.1 V0 的核心目标

V0 定义为：

> 一个持久化、可恢复、可验证的单 Worker Coding Goal 自动执行循环。

用户在 UI 中选择 Workspace、Worker Provider，并输入一个较大的 Coding
Goal。此后系统应能够：

``` text
Goal
 ↓
Bootstrap Analysis
 ↓
Initial Roadmap
 ↓
Current Task
 ↓
Worker Execute
 ↓
Evidence Collection
 ↓
Verification
 ├─ PASS → Rolling Planning → Next Task
 ├─ FAIL → Repair Task → Retry
 └─ UNCERTAIN / repeated failure → Human Intervention
 ↓
Final Goal Verification
 ↓
Completed / Needs Human
```

V0 最重要的产品指标不是"多 Agent"，而是：

> 用户是否能够给出一个较大的 Coding Goal 后，不再反复输入"继续下一步"。

------------------------------------------------------------------------

## 3.2 V0 范围

V0 支持：

-   单 Workspace。
-   单 Goal 执行。
-   单 Worker 串行执行任务。
-   Worker Provider 可预留 Claude / Codex 适配能力；一次 Goal
    只使用一个主要 Worker。
-   高层 Roadmap + Rolling Planning。
-   Task Contract。
-   Project State。
-   Execution Memory。
-   Working Set。
-   Evidence-first Verification。
-   Repair / Retry。
-   Human-in-the-loop。
-   Goal-level Final Verification。
-   与 AgentScope 现有 Session / Timeline / Progress / ETA / Git / File
    / Test 观测能力集成。
-   最小统一 UI。

V0 暂不做：

-   多 Worker 并行。
-   DAG Scheduler。
-   Git Worktree。
-   自动 Merge。
-   Worker 间通信。
-   智能 Provider Router。
-   跨机器执行。
-   团队协作。
-   完整交互式 TTY。
-   复杂聊天式实时改需求。
-   Vector DB / Knowledge Graph 等重型记忆系统。

------------------------------------------------------------------------

# 4. V0 的规划策略

## 4.1 高层 Roadmap + Rolling Planning

不采用"一开始把全部任务完全写死"，也不采用"每完成一步就完全重新规划"。

采用混合方式：

1.  Goal 开始时生成高层 Roadmap。
2.  当前只锁定一个 Task。
3.  保留未来 2--4 个 tentative tasks，供用户理解方向。
4.  每个 Task 验证完成后，根据最新 Project State、Execution
    Memory、Working Set 和 Evidence 决定：
    -   延续原计划；
    -   修改后续任务；
    -   插入新任务；
    -   删除已经不需要的任务。
5.  默认优先延续已有计划，只有获得新的项目事实或验证失败等充分理由时才重规划。

这样兼顾稳定性与灵活性。

------------------------------------------------------------------------

# 5. V0 的上下文与记忆

## 5.1 Project State

Project State 描述"项目现在是什么样"，尽量来自机器事实：

-   Workspace。
-   技术栈。
-   Git branch / HEAD / dirty state。
-   changed files。
-   tests / typecheck / build 状态。
-   relevant modules。
-   recent changes。
-   AgentScope 观测到的运行状态。

## 5.2 Execution Memory

Execution Memory 描述"为什么走到这里"：

-   原始 Goal。
-   用户 Constraints。
-   Architecture Decisions。
-   Completed Tasks 摘要。
-   Known Issues。
-   Open Questions。
-   Verification conclusions。

决策建议分级：

-   `LOCKED`：用户明确要求，Planner 不得自行推翻。
-   `STABLE`：已经形成的重要架构决策，除非有充分证据否则保持。
-   `TENTATIVE`：局部实现决策，可根据后续状态调整。

## 5.3 Working Set

Planner 不应该每轮重新读取整个 Repository。

Working Set 保存当前 Goal 最相关的：

-   files；
-   symbols；
-   tests；
-   docs；
-   recent diffs。

如果 Planner 信息不足，应主动请求 inspect / code search，再补充 Working
Set，而不是猜测。

## 5.4 分层上下文

Planner Context 建议分为：

1.  永久携带：Goal、Constraints、Architecture Decisions。
2.  状态摘要：Current Task、Completed Tasks、Known
    Issues、Verification。
3.  Working Set：相关文件、Symbols、最近 Diff。
4.  按需读取：需要时再查询具体代码。

V0 不需要 Vector DB；结构化状态 + Code Search 足够。

------------------------------------------------------------------------

# 6. Task Contract

每一个 Task 必须结构化定义，而不是只有一句自然语言。

建议至少包含：

``` yaml
id: AUTH-003
title: Implement login endpoint
objective: Implement POST /api/auth/login

acceptance_criteria:
  - Valid credentials return HTTP 200
  - Invalid credentials return HTTP 401
  - JWT token is returned
  - Existing behavior remains unchanged

verification:
  - pnpm test auth
  - pnpm typecheck

constraints:
  - Do not modify unrelated packages

max_attempts: 3
```

Task Contract 的意义是同时告诉：

-   Worker：应该完成什么；
-   Verifier：什么才算完成；
-   Planner：当前 Task 的边界在哪里。

Worker 不应擅自继续执行其他 planned tasks。

------------------------------------------------------------------------

# 7. Worker 与 Worker Result

Worker 接收：

-   Task Contract；
-   必要的 Project Context；
-   Working Set；
-   Previous Attempt / Failure Evidence（如果是 Repair）。

Worker 完成后返回结构化 Worker Result。

Worker 的结果只能称为 `claimed_status`，不能直接成为系统最终状态，因为
Worker 自称完成并不意味着真的完成。

系统需要独立 Verification。

------------------------------------------------------------------------

# 8. Verifier

Verifier 是 V0 的可靠性核心。

原则：

> Evidence → Judgment，而不是 Worker Summary → Judgment。

## 8.1 Evidence Collector

收集：

-   Git diff；
-   changed files；
-   command exit codes；
-   targeted tests；
-   typecheck；
-   lint；
-   build；
-   runtime evidence；
-   AgentScope events。

## 8.2 Deterministic Verification

优先使用机器可验证信息：

-   tests；
-   build；
-   typecheck；
-   lint；
-   expected files；
-   exit codes；
-   API / CLI 行为。

## 8.3 Contract Verification

对 Task Contract 中每一个 Acceptance Criterion 独立给出：

-   PASS；
-   FAIL；
-   UNCERTAIN；
-   Evidence。

## 8.4 Regression Gate

不需要每个 Task 都跑全量验证。

可以采用：

-   Fast Gate：targeted tests + typecheck。
-   Periodic Gate：模块级 / 更广测试。
-   Final Gate：full test suite + build + Goal Verification。

## 8.5 Goal-level Verification

Roadmap 即将结束时，必须重新对照用户最初 Goal，而不是只看 Tasks
是否全部显示 Completed。

逐条检查原始需求是否有 Evidence。

如果发现缺口：

``` text
Missing Requirement
→ Generate Gap Task
→ Worker
→ Verify
```

只有 Goal-level Verification 通过后，Goal 才能真正标记为 Completed。

------------------------------------------------------------------------

# 9. Repair / Retry

Verification 失败后，不应简单重复原 Prompt。

应生成 Repair Task，携带：

-   parent task；
-   failed acceptance criterion；
-   failure evidence；
-   当前 Project State；
-   已经完成的部分；
-   repair objective。

建议默认 `max_attempts = 3`。

超过次数后进入 `NEEDS_HUMAN`，禁止无限自主循环。

------------------------------------------------------------------------

# 10. Human-in-the-loop

V0 至少支持：

-   `RUNNING`
-   `PAUSED`
-   `NEEDS_HUMAN`
-   `COMPLETED`
-   `FAILED / ABORTED`

以下情况应考虑停止并请求人工：

-   多次 Repair 仍失败；
-   需求存在重大歧义；
-   高风险操作；
-   权限 / Secret 问题；
-   Planner 无法可靠判断；
-   Verifier 返回关键 `UNCERTAIN`；
-   超出预算 / 时间 / Attempt 限制。

------------------------------------------------------------------------

# 11. V0 UI

最终目标是把 Orchestrator 与 AgentScope Dashboard 合成统一 UI。

V0 就开始做 UI，但保持最小范围。

## 11.1 New Goal

支持：

-   Workspace；
-   Goal 输入；
-   Provider；
-   Start。

V0 不需要完整 Chat UI。

## 11.2 Goal View

显示：

-   Goal Status；
-   Overall Progress / ETA；
-   High-level Roadmap；
-   Current Task；
-   Acceptance Criteria；
-   Worker；
-   Attempt；
-   Verification；
-   Timeline；
-   AgentScope Evidence。

未来任务标记为 tentative。

## 11.3 Control

V0 至少支持：

-   Pause；
-   Abort。

复杂的实时追加需求、编辑 Roadmap、切 Provider 等放到 V1。

## 11.4 UI 架构原则

前端不得直接启动 Claude / Codex。

必须保持：

``` text
UI / CLI
   ↓
AgentScope Server
   ↓
Orchestrator Service
   ↓
Worker Runtime
   ↓
Claude / Codex
```

UI 和 CLI 只是不同入口，共享同一个 Orchestrator Core。

------------------------------------------------------------------------

# 12. V0 数据模型建议

在现有 AgentScope Session 数据之上增加：

``` text
goals
tasks
task_attempts
verification_runs
orchestrator_events
```

基本关系：

``` text
Goal
 ├── Task
 │    ├── Attempt
 │    │    └── AgentScope Session
 │    └── Attempt
 └── Task
```

建议把 Raw History、Structured State、Semantic Memory 分开：

-   Raw History：Agent events / logs / evidence，用于
    Dashboard、Debug、Audit。
-   Structured State：Goal / Task / Attempt / Verification 状态。
-   Semantic Memory：Planner 所需的 Decisions、Completed Task
    summaries、Known Issues 等。

------------------------------------------------------------------------

# 13. V0 验收

V0 应通过真实 Coding Tasks 验收，而不是只看 Demo。

建议准备约 10 类任务，例如：

-   增加 API；
-   修复有测试覆盖的 Bug；
-   React 页面；
-   Schema 修改；
-   Module Refactor；
-   CLI Option；
-   Logging；
-   Type Error；
-   Unit Test；
-   小型跨前后端 Feature。

重点指标：

-   Goal Completion Rate；
-   Task Success Rate；
-   Average Repair Attempts；
-   Human Intervention Rate；
-   Runtime；
-   Token / Cost；
-   **False Completion Rate**。

其中 False Completion Rate 应作为最重要的可靠性指标之一。

------------------------------------------------------------------------

# 14. V1 路线

V1 目标：

> 将 Dashboard 与 Orchestrator 深度融合为完整 Agent Control Center。

主要增加：

-   Persistent Goals。
-   更完整 Crash Recovery。
-   Human Intervention 输入框。
-   Give Instruction / Continue。
-   Retry / Resume。
-   Roadmap 编辑。
-   Task 插入 / 删除。
-   更强 Execution Memory。
-   Goal / Session 历史。
-   更成熟的 UI。
-   更完善的权限和风险控制。
-   更丰富的通知机制。

V1 仍可优先保证单 Worker 的可靠性，再逐步为多 Worker 做准备。

------------------------------------------------------------------------

# 15. V2 路线

V2 重点进入 Multi-Agent / Multi-Worker：

-   多 Worker 并行。
-   DAG Scheduler。
-   Task Dependencies。
-   Claude + Codex 等多 Provider。
-   Git Worktree 隔离。
-   Parallel Execution。
-   Conflict / Merge Handling。
-   Intelligent Router。
-   根据历史成功率、成本、速度自动选择 Worker。
-   Worker Graph / DAG UI。
-   Parallel Progress。
-   多项目。
-   Remote Dashboard。
-   Analytics / Cost。
-   Team / Governance 的基础能力。

长期 AgentScope 可以进一步演进为 Agent Control Plane / Agent Platform。

------------------------------------------------------------------------

# 16. 当前推荐开发顺序

``` text
AgentScope Monitor V0
        ↓
Orchestrator Core
        ↓
Goal / Task / Attempt 状态机
        ↓
Project State + Execution Memory + Working Set
        ↓
Initial Planner + Rolling Planner
        ↓
Worker Runtime Integration
        ↓
Evidence Collector
        ↓
Verifier
        ↓
Repair Loop
        ↓
Goal-level Verification
        ↓
Persistence / Recovery
        ↓
Minimal Unified UI
        ↓
V0 Real-task Acceptance
        ↓
V1
        ↓
V2
```

现阶段优先把 V0 的自主执行闭环做可靠，不应为了多 Agent、复杂 UI
或高级智能 Router 提前扩大范围。
