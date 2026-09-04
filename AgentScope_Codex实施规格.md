# AgentScope Engineering Plan（Codex 执行版）

*Implementation specification · Requirements, architecture, milestones, contracts, acceptance criteria*

## 0. 你的任务

实现一个本地优先（local-first）的 AI Coding Agent 可观测平台 AgentScope。第一版必须优先支持 Claude Code CLI 与 Codex CLI，并通过 Adapter 架构保证未来可以增加 Codex App、IDE Agent、Kimi/Gemini CLI、Docker/SSH/remote execution。

| **执行原则**                                                                                                                                                  |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 先建立可运行的纵向切片（capture → normalize → store → state → API/WebSocket → UI），再扩充事件种类。不要一开始实现复杂 ETA ML、账号系统、云同步或所有 Agent。 |

## 1. Functional Requirements

1.  能够通过 wrapper 启动 Claude Code CLI / Codex CLI，并尽可能采集其 structured output、stdout/stderr、process lifecycle。

2.  将不同 Agent 的原始信息转换为统一 AgentEvent。

3.  维护 SessionState：running / blocked / completed / failed / interrupted，以及 currentActivity、elapsed、milestones、progress、ETA。

4.  采集 workspace 的 Git/file/test 信号作为 Agent 原生事件的补充。

5.  通过 SQLite 保存 session、event、milestone、ETA snapshot。

6.  通过 HTTP API + WebSocket/SSE（优先 WebSocket）提供实时数据。

7.  React Dashboard 展示多 session 总览和单 session timeline。

8.  Progress 不允许单纯由 Agent 自报；验证未完成前默认不能到 100%。

9.  ETA 使用范围 + confidence；允许随着失败/阻塞上升。

10. 核心代码必须能在没有真实 Claude/Codex 的 CI 环境中通过 MockAdapter 完成单元与集成测试。

## 2. Non-Goals for V0

- 不读取、存储或展示私有 chain-of-thought。

- 不通过截图 OCR / GUI automation 抓 Codex App UI。

- 不做多用户、账号系统、云端同步。

- 不做机器学习 ETA；只做 deterministic / heuristic estimator。

- 不承诺所有 Agent 事件都可捕获；必须用 capability 和 confidence 表达缺失。

- 不把 Codex App 作为 Phase 1 blocker。

## 3. Proposed Tech Stack

| **层**   | **建议**                                                                        |
|----------|---------------------------------------------------------------------------------|
| Monorepo | pnpm workspace                                                                  |
| Language | TypeScript strict mode                                                          |
| Backend  | Node.js 22+；Fastify 或轻量 HTTP framework                                      |
| Realtime | WebSocket                                                                       |
| DB       | SQLite + Drizzle ORM（或等价轻量方案）                                          |
| Frontend | React + Vite + TypeScript + Tailwind                                            |
| CLI      | Node CLI；commander / citty 等轻量库                                            |
| Testing  | Vitest；必要时 Playwright 做 dashboard smoke test                               |
| Process  | node:child_process spawn，禁止 exec 拼接 shell 字符串作为通用路径               |
| Git      | 优先直接调用 git CLI 并解析稳定 machine-readable 输出；封装在 WorkspaceObserver |

## 4. Repository Layout

    agentscope/
    ├─ apps/
    │ ├─ server/
    │ ├─ dashboard/
    │ └─ cli/
    ├─ packages/
    │ ├─ protocol/ # AgentEvent, SessionState, capabilities
    │ ├─ core/ # event bus, reducer/state engine
    │ ├─ adapters/
    │ │ ├─ base/
    │ │ ├─ mock/
    │ │ ├─ claude-code/
    │ │ └─ codex-cli/
    │ ├─ observers/
    │ │ ├─ process/
    │ │ ├─ git/
    │ │ ├─ filesystem/
    │ │ └─ tests/
    │ ├─ progress/
    │ ├─ eta/
    │ ├─ storage/
    │ └─ shared/
    ├─ docs/
    │ ├─ architecture.md
    │ ├─ event-protocol.md
    │ └─ adapter-guide.md
    └─ tests/fixtures/

## 5. Protocol Contracts

### 5.1 AgentEvent

    export type AgentEventType =
    | "session_started"
    | "session_finished"
    | "planning"
    | "agent_message"
    | "tool_call_started"
    | "tool_call_finished"
    | "file_read"
    | "file_write"
    | "command_started"
    | "command_finished"
    | "test_started"
    | "test_passed"
    | "test_failed"
    | "milestone_started"
    | "milestone_completed"
    | "blocked"
    | "unblocked"
    | "error";

    export interface AgentEvent<T = unknown> {
    id: string;
    sessionId: string;
    timestamp: number;
    source: {
    provider: string;
    client: string;
    environment: string;
    adapter: string;
    };
    type: AgentEventType;
    payload: T;
    confidence: number; // 0..1
    rawRef?: string; // reference to raw log, do not duplicate large payloads
    }

### 5.2 Adapter Capability

    export interface AgentCapabilities {
    structuredEvents: boolean;
    toolCalls: boolean;
    fileEvents: boolean;
    commandEvents: boolean;
    tokenUsage: boolean;
    sessionInfo: boolean;
    milestones: boolean;
    }

    export interface AgentAdapter {
    readonly id: string;
    detect(ctx: AdapterDetectContext): Promise<DetectionResult>;
    capabilities(): AgentCapabilities;
    start?(request: StartAgentRequest): Promise<AttachedSession>;
    attach?(request: AttachAgentRequest): Promise<AttachedSession>;
    }

AttachedSession 必须暴露 async event stream 或 subscribe(onEvent)，以及 stop/detach 生命周期。Core 不得 import claude/codex-specific types。

### 5.3 SessionState

    export interface SessionState {
    sessionId: string;
    status: "starting" | "running" | "blocked" | "completed" | "failed" | "interrupted";
    startedAt: number;
    endedAt?: number;
    currentActivity?: Activity;
    milestones: Milestone[];
    progress: { value: number; confidence: number; reasons: string[] };
    eta?: { minSeconds: number; maxSeconds: number; confidence: number; reasons: string[] };
    workspace?: WorkspaceState;
    verification: VerificationState;
    }

## 6. Data Source Priority

| **优先级** | **数据源**                        | **使用原则**                            |
|------------|-----------------------------------|-----------------------------------------|
| P0         | Agent structured event / hook     | 优先使用，但仍需 normalize + validate   |
| P1         | Process stdout/stderr + exit code | 用于 lifecycle、命令结果和文本 fallback |
| P1         | Git / filesystem observer         | 用于客观确认 workspace activity         |
| P1         | Test/build command result         | Progress/verification 的高权重信号      |
| P2         | Agent 自报 milestone/progress     | 可用作解释和计划，不可单独决定完成度    |
| 禁止       | OCR / screenshot / UI scraping    | V0 不实现                               |

## 7. Progress Engine V0

实现 deterministic、可解释的 Progress Engine。每次计算返回 value + confidence + reasons。

| **阶段**                       | **默认权重** |
|--------------------------------|--------------|
| planning / understanding       | 0.10         |
| implementation                 | 0.50         |
| unit verification              | 0.15         |
| integration/build verification | 0.15         |
| final review                   | 0.10         |

- 如果没有 milestone，使用 activity heuristics 建立隐式阶段，但 confidence 下调。

- 仅实现阶段结束：progress 上限默认 0.60。

- 有 test/build requirement 的项目，未验证时不能到 1.0。

- test_failed / blocked 可使 progress 回退；不要强制单调递增。

- session completed 但 verification failed 时：状态 failed，progress 不应伪装为 100% successful。

- 所有 magic numbers 统一放 config，并写单元测试。

## 8. ETA Engine V0

    baseRemaining = elapsedSeconds / max(progress, MIN_PROGRESS) * (1 - progress)

    riskMultiplier =
    1.0
    + failedTestPenalty
    + blockerPenalty
    + lowSignalPenalty
    + replanningPenalty

    center = baseRemaining * riskMultiplier
    range = confidence-dependent interval around center

- progress \< 最低阈值（如 0.08）时，不给具体分钟，返回 insufficient_data 或非常宽区间。

- ETA 结果必须包含 reasons，例如 “2 failed test runs”, “no native events”, “verification pending”。

- confidence 来自 adapter capability、event freshness、milestone availability、历史 event density。

- 禁止把 ETA 显示为精确单点；API 输出 minSeconds/maxSeconds/confidence。

## 9. Workspace Observers

| **Observer**    | **职责**                                                       | **注意**                                            |
|-----------------|----------------------------------------------------------------|-----------------------------------------------------|
| ProcessObserver | PID、start/end、exit code、child process metadata              | 不得读取不相关进程隐私数据                          |
| GitObserver     | branch、dirty files、diff stat、optional commits               | 使用 cwd-scoped repo；避免频繁全量 diff             |
| FileObserver    | workspace 内文件 create/modify/delete                          | debounce；尊重 ignore/.gitignore；避免 node_modules |
| TestObserver    | 识别 wrapper 内主动运行的 test/build/lint/typecheck 命令及结果 | 先规则化常见命令，不追求任意 shell 完美识别         |

## 10. CLI UX

    # server/dashboard
    agent-scope start

    # wrap an agent process
    agent-scope run claude -- [claude args...]
    agent-scope run codex -- [codex args...]

    # inspect
    agent-scope sessions
    agent-scope show <session-id>

    # dev/testing
    agent-scope run mock --fixture basic-success

要求：wrapper 必须尽量透传 stdin/stdout/stderr 和 exit code，不能明显破坏原 CLI 交互体验。若某种 structured output 模式与 interactive TTY 冲突，先实现 non-interactive/programmable path，并在 docs 中说明能力边界。

## 11. API / Realtime

    GET /api/sessions
    GET /api/sessions/:id
    GET /api/sessions/:id/events?after=<cursor>
    GET /api/projects/:id/overview

    WS /ws
    messages:
    session.created
    session.updated
    event.appended
    project.updated

事件传输必须有 sequence/cursor，前端断线重连后可通过 HTTP 补齐缺失事件，不要假设 WebSocket 永不丢消息。

## 12. Dashboard V0

- Project overview：active / blocked / completed counts。

- AgentCard：agent/client/environment、status、progress、elapsed、ETA、currentActivity、last event。

- Session detail：timeline、milestones、verification、changed files、recent commands。

- 明确显示 confidence；native data 和 inferred data 可以用标签区分。

- 不要先做复杂图表。优先信息密度、实时反馈和可读性。

## 13. Storage Schema（初版）

    sessions(
    id, project_id, adapter_id, provider, client, environment,
    cwd, status, started_at, ended_at, metadata_json
    )

    events(
    id, session_id, seq, timestamp, type, confidence,
    payload_json, raw_ref
    )

    milestones(
    id, session_id, name, weight, status, started_at, ended_at
    )

    eta_snapshots(
    id, session_id, timestamp, min_seconds, max_seconds, confidence, reasons_json
    )

不要过早做复杂 normalized schema；payload_json 允许协议演进。关键查询字段（session_id、seq、timestamp、type）建立索引。

## 14. Implementation Phases

| **Phase**             | **Deliverables**                                 | **Definition of Done**                                                                 |
|-----------------------|--------------------------------------------------|----------------------------------------------------------------------------------------|
| 0 · Capability Spike  | scripts/experiments + findings.md                | 真实验证 Claude/Codex CLI 可捕获信号；记录命令、输出示例、交互限制；不要凭记忆假设 API |
| 1 · Protocol/Core     | protocol package, EventBus, reducer, MockAdapter | Mock fixture 可驱动 session 从 start → events → completed；测试覆盖 reducer/lifecycle  |
| 2 · Storage/Server    | SQLite repo + HTTP/WS server                     | 事件持久化；重启后 session 可查询；WS 能实时发 update                                  |
| 3 · Claude Adapter    | Claude Code wrapper/adapter                      | 至少捕获 lifecycle + 可用 structured events + fallback；fixture test + manual smoke    |
| 4 · Codex Adapter     | Codex CLI wrapper/adapter                        | 同上；Codex-specific 解析隔离在 adapter 包                                             |
| 5 · Workspace Signals | git/file/test observers                          | Agent 不提供 native event 时仍能看到客观活动                                           |
| 6 · Progress          | progress engine + reasons                        | 验证前不 100%；fail/blocker 能回退；单元测试覆盖典型路径                               |
| 7 · Dashboard         | overview + session detail                        | 两个同时运行 session 可实时展示                                                        |
| 8 · ETA V0            | heuristic estimator + snapshots                  | 返回 range/confidence/reasons；失败和低信号能增宽 ETA                                  |
| 9 · Hardening         | cross-platform path/process handling, docs       | 至少在目标开发环境完成 Windows/WSL 或 macOS/Linux smoke tests                          |

## 15. Phase 0 必须先验证的问题

11. Claude Code CLI 当前稳定支持哪些 machine-readable / structured output 模式？interactive 与 structured mode 是否能同时保留？

12. Codex CLI 当前有哪些可稳定消费的 structured events / JSON output / logs？哪些属于内部实现、不可作为稳定契约？

13. 两者的 session identifier 是否可获得；如果不可获得，AgentScope 自己生成 sessionId。

14. 在 Windows native、WSL、macOS/Linux 中 spawn + signal forwarding + TTY 行为有哪些差异？

15. 哪些命令/事件可以明确识别 test/build/typecheck，哪些只能作为 generic command。

16. Codex App 是否存在官方或稳定的可观测接口；若不确定，记录为 future spike，不阻塞 V0。

| **禁止事项**                                                                                                                                                  |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 不要根据旧知识硬编码 Claude/Codex 的事件名。Phase 0 使用当前安装版本/官方文档/--help/真实输出做验证，并把原始样例保存到 tests/fixtures/raw/（去除敏感信息）。 |

## 16. Testing Strategy

| **层**    | **测试**                                                                            |
|-----------|-------------------------------------------------------------------------------------|
| Protocol  | schema validation / serialization / backward compatibility basic tests              |
| Core      | event reducer, lifecycle, ordering, dedupe, out-of-order handling                   |
| Adapters  | raw fixture → normalized AgentEvent golden tests                                    |
| Observers | temporary git repo + synthetic file/test/process scenarios                          |
| Progress  | success, fail, blocker, replan, no-milestone cases                                  |
| ETA       | early low-data, normal progress, failed tests, blocker, completion                  |
| Server    | API integration + WS reconnect/catch-up                                             |
| E2E       | MockAdapter drives dashboard; optional real CLI smoke test excluded from default CI |

## 17. Engineering Constraints

- TypeScript strict；尽量避免 any。

- 所有 Agent-specific parsing 必须在 adapters/\* 内。

- Core 不得依赖 React、CLI implementation 或某家 Agent SDK。

- 不要记录环境变量、完整 prompt、密钥、token；raw log storage 默认关闭或做明确配置。

- 日志默认结构化且可设级别；不要把 Agent 原始 stdout 重复打印到 server log。

- 文件监听必须限制 workspace，尊重 ignore，避免扫描用户整个磁盘。

- 所有长生命周期资源（child process、watcher、WS、DB）必须有显式 cleanup。

- 跨平台路径必须使用 Node path API；WSL/Windows 转换封装，不散落在业务代码。

## 18. Acceptance Criteria for V0

17. agent-scope start 后 Dashboard 可访问。

18. 能够运行两个 Mock session 并在 UI 同时看到实时状态。

19. 至少一个真实 Claude Code CLI session 和一个真实 Codex CLI session 可以被监控（具体事件丰富度按 capability 说明）。

20. 关键事件到 Dashboard 的本地延迟目标 \< 3 秒。

21. CLI 进程 exit code、interrupted、failed、completed 状态不会混淆。

22. Progress 输出 value/confidence/reasons，验证前不会虚假 100%。

23. ETA 输出 min/max/confidence/reasons；测试失败后允许变长。

24. SQLite 可保存并重新加载历史 session。

25. 断开 Dashboard 再连接后，不丢失已持久化 timeline。

26. 新增 ExampleAdapter 只需实现 adapter contract，不需要修改 Core/Storage/Dashboard 的关键逻辑。

## 19. Recommended First Coding Sequence

    Step 1 init pnpm monorepo + lint/test/typecheck
    Step 2 packages/protocol
    Step 3 packages/core + MockAdapter
    Step 4 packages/storage + apps/server
    Step 5 minimal apps/dashboard
    Step 6 Phase-0 experiments for Claude/Codex
    Step 7 Claude adapter
    Step 8 Codex adapter
    Step 9 workspace observers
    Step 10 Progress engine
    Step 11 ETA engine
    Step 12 hardening + docs

## 20. Codex 工作方式要求

- 每完成一个 Phase，先运行对应 tests/typecheck，再进入下一 Phase。

- 遇到无法确认的 Claude/Codex 行为，优先做最小实验并把结果写入 docs/findings，而不是猜。

- 对外协议先小后稳：先少量事件类型跑通纵向链路，确认后再增加。

- 每个 Phase 提交（或至少形成）清晰变更边界；避免一次性改完整仓库。

- 发现需求冲突时优先保证：跨 Agent 解耦 \> 可观测性真实性 \> UI 丰富度 \> ETA 精度。

- 如果某真实 Agent 暂时无法稳定接入，必须保留 MockAdapter + external signals 使主系统仍可运行，不得为了“支持”而写脆弱 UI scraping。

| **最终目标**                                                                                                                                                                                                                         |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| V0 的成功不是“做出漂亮进度条”，而是建立一个可信的数据链路：Agent/Environment → Normalized Events → Session State → Progress/ETA → Realtime UI。只要这条链稳定，Codex App、多 Agent Planner、远程执行、成本分析都可以在其上继续扩展。 |
