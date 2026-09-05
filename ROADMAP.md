# AgentScope V0 实施路线图

> 状态：待实施
> 依据：`AgentScope_Codex实施规格.md`、`AgentScope_项目规划_用户版.md`
> 目标版本：V0（本地优先、单用户、Claude Code CLI + Codex CLI）
> 使用方式：按 Phase 顺序推进；每完成一个 Step，勾选任务并附上测试、文档或实验结果。未通过阶段门禁时，不进入依赖该阶段的后续开发。

## 1. 需求理解与最终目标

AgentScope 要解决的不是“做一个看起来连续增长的进度条”，而是建立一条可信、可解释、可恢复的 Agent 可观测链路：

```text
Agent / Workspace
        ↓ capture
Provider Adapter + Workspace Observers
        ↓ normalize
Unified AgentEvent
        ↓ persist/reduce
SQLite + Session State
        ↓ estimate
Progress + ETA
        ↓ deliver
HTTP API + WebSocket + React Dashboard
```

V0 完成时，用户应能在本机启动 AgentScope，用 wrapper 分别运行 Claude Code CLI 与 Codex CLI，同时看到多个 session 的实时状态、当前活动、客观文件/命令/测试信号、可解释进度和区间型 ETA；刷新或短暂断线后仍能恢复完整 timeline。

### 1.1 V0 必须达成的产品结果

- [ ] 可通过 `agent-scope start` 启动后端与 Dashboard。
- [ ] 可通过 `agent-scope run claude -- ...` 和 `agent-scope run codex -- ...` 启动并监控真实 CLI。
- [ ] 可通过 `agent-scope run mock --fixture ...` 在没有真实 Agent 的 CI 中跑通全链路。
- [ ] Dashboard 可同时展示至少两个运行中的 session。
- [ ] 关键事件从产生到 UI 可见的本地延迟目标小于 3 秒。
- [ ] session 的 `completed`、`failed`、`interrupted`、`blocked` 状态不会混淆。
- [ ] Progress 输出 `value + confidence + reasons`，在必要验证完成前不会显示 100%。
- [ ] ETA 输出 `minSeconds + maxSeconds + confidence + reasons`，失败、阻塞和低信号会增大区间或降低置信度。
- [ ] SQLite 可在服务重启后恢复历史 session 和 timeline。
- [ ] WebSocket 断线重连后，可用 cursor 通过 HTTP 补齐缺失事件。
- [ ] 新增 ExampleAdapter 时，无需修改 Core、Storage 或 Dashboard 的关键逻辑。

### 1.2 V0 明确不做

- 私有 chain-of-thought 的读取、存储或展示。
- OCR、截图识别或 GUI automation 抓取 Codex App。
- 多用户、账号、权限、云同步、远程控制面。
- 机器学习 ETA、相似任务检索、精确单点 ETA。
- Codex App 原生接入、IDE Agent、Kimi/Gemini、Docker/SSH；只保留扩展接口和后续调研项。
- token/cost 完整分析、通知系统、复杂图表和高级趋势报表。

### 1.3 实施优先级

出现需求冲突时按以下顺序取舍：

1. 跨 Agent 解耦。
2. 可观测信息真实性与隐私安全。
3. 纵向链路可运行、可测试、可恢复。
4. UI 信息密度与可读性。
5. Progress/ETA 的精细程度。

## 2. 总体工程约束

- TypeScript strict mode；避免 `any`，跨边界输入必须运行时校验。
- Core 只理解统一协议，不 import Claude/Codex 专用类型。
- Provider-specific 解析只能存在于 `packages/adapters/*`。
- 通用进程启动使用 `spawn` 参数数组，不拼接 shell 字符串执行。
- 默认不记录环境变量、密钥、token、完整 prompt 或原始 stdout；raw log 默认关闭。
- 文件监听严格限制在 workspace，尊重 `.gitignore` 和 AgentScope ignore 配置。
- child process、watcher、WebSocket、timer、DB 都必须有显式 cleanup。
- Windows/WSL/macOS/Linux 的路径和信号差异集中封装，不散落到业务代码。
- 每个 Phase 完成后先运行对应的 lint、typecheck、test，再通过阶段门禁。
- 所有启发式常量集中到配置，不能在 reducer、Progress 或 ETA 代码中散落 magic numbers。

## 3. 目标仓库结构

```text
agentscope/
├─ apps/
│  ├─ server/
│  ├─ dashboard/
│  └─ cli/
├─ packages/
│  ├─ protocol/
│  ├─ core/
│  ├─ adapters/
│  │  ├─ base/
│  │  ├─ mock/
│  │  ├─ claude-code/
│  │  └─ codex-cli/
│  ├─ observers/
│  │  ├─ process/
│  │  ├─ git/
│  │  ├─ filesystem/
│  │  └─ tests/
│  ├─ progress/
│  ├─ eta/
│  ├─ storage/
│  └─ shared/
├─ docs/
│  ├─ architecture.md
│  ├─ event-protocol.md
│  ├─ adapter-guide.md
│  ├─ privacy.md
│  └─ findings/
├─ scripts/experiments/
└─ tests/fixtures/
   ├─ normalized/
   └─ raw/
```

## 4. 里程碑总览与依赖

| Phase | 里程碑 | 前置依赖 | 核心交付物 | 阶段门禁 |
|---|---|---|---|---|
| 0 | 基线与能力实测 | 无 | capability matrix、脱敏原始样例、ADR | 不再凭旧知识猜 CLI 行为 |
| 1 | Monorepo 工程基座 | Phase 0 可并行起步 | workspace、质量脚本、CI | 全空项目 lint/typecheck/test 通过 |
| 2 | Protocol | Phase 1 | AgentEvent、State、capability、校验器 | 协议测试与兼容性测试通过 |
| 3 | Core + MockAdapter | Phase 2 | EventBus、reducer、mock fixtures | Mock session 全生命周期可重放 |
| 4 | Storage + Server | Phase 3 | SQLite、HTTP、WebSocket | 重启恢复、实时推送、补齐事件通过 |
| 5 | CLI 与进程生命周期 | Phase 3–4 | start/run/sessions/show、wrapper | 透传 I/O/exit code，信号状态正确 |
| 6 | 最小 Dashboard | Phase 4–5 | overview、card、timeline | 两个 Mock session 实时展示 |
| 7 | Claude Code Adapter | Phase 0、2、5 | adapter、fixtures、capability | 真实 smoke + fixture golden test |
| 8 | Codex CLI Adapter | Phase 0、2、5 | adapter、fixtures、capability | 真实 smoke + fixture golden test |
| 9 | Workspace Observers | Phase 3、5 | process/git/file/test observers | 无原生事件时仍有客观活动信号 |
| 10 | Progress V0 | Phase 3、9 | 可解释、可回退的进度引擎 | 验证前不 100%，典型路径测试通过 |
| 11 | ETA V0 | Phase 10 | 区间 ETA 与 snapshots | 低信号/失败/阻塞行为符合预期 |
| 12 | 集成加固与 V0 发布 | Phase 0–11 | E2E、文档、跨平台 smoke | 全部 V0 验收项有证据 |

---

## Phase 0 — 项目基线与 Capability Spike

**目的：** 先确认当前安装版本和官方稳定接口实际能提供什么，消除 Claude/Codex 接入的最大不确定性。

### Step 0.1 — 建立基线文档与决策记录

- [x] 创建 `docs/architecture.md`，描述组件边界、数据流、依赖方向和不允许的反向依赖。
- [x] 创建 `docs/decisions/`，采用短 ADR 记录关键决策：HTTP framework、SQLite/ORM、运行时 schema 库、WebSocket 库、raw log 策略。
- [x] 创建 `docs/privacy.md`，列出允许采集、默认不采集、禁止采集的数据。
- [x] 记录目标运行环境：Node/pnpm 版本、Windows native/WSL/macOS/Linux 的 V0 支持级别。
- [x] 明确“支持”的定义：fixture test、真实 manual smoke、文档化限制三者缺一不可。

**产物/验证：** 架构图、ADR、隐私边界和环境矩阵可被 code review；所有未决项有 owner 和关闭条件。

### Step 0.2 — 实测 Claude Code CLI

- [x] 记录当前安装版本、`--help` 和可用的官方文档入口。
- [x] 枚举 machine-readable/structured output、hooks、非交互模式、resume/session id 等公开能力。
- [ ] 用最小无敏感仓库运行成功、失败、工具调用、文件修改、测试命令、用户中断等场景。
- [ ] 比较 interactive TTY 与 structured/non-interactive 模式是否兼容。
- [ ] 验证 stdout/stderr 的通道、刷新行为、编码、退出码和 signal forwarding。
- [x] 仅保存脱敏后的原始输出到 `tests/fixtures/raw/claude-code/`。
- [x] 标记每个字段为 stable/public、observed-but-unstable 或 unavailable。
- [x] 形成 `docs/findings/claude-code.md` 和 capability matrix 条目。

**产物/验证：** 已覆盖 success、tool/test failure 和 fallback 证据；interactive trust-screen 取消已观察，但可靠的 structured Ctrl+C fixture、TTY 兼容性和 signal forwarding 仍待补测，因此本 Step 尚未完成。

### Step 0.3 — 实测 Codex CLI

- [x] 记录当前安装版本、`--help` 和官方文档入口。
- [x] 枚举 JSON/structured events、日志、session id、非交互/exec 模式和恢复能力。
- [ ] 区分官方稳定输出与内部实现细节；内部事件不得成为唯一契约。
- [ ] 用与 Claude 相同的场景采集输出，便于后续做归一化对照。
- [ ] 验证 TTY、stdin/stdout/stderr、退出码、Ctrl+C、终端 resize 和编码行为（Ctrl+C/退出码已观察；TTY/resize/编码仍待补测）。
- [x] 将脱敏样例保存到 `tests/fixtures/raw/codex-cli/`。
- [x] 形成 `docs/findings/codex-cli.md` 和 capability matrix 条目。

**产物/验证：** 已覆盖 success、command failure 和 structured fallback 证据；Ctrl+C、TTY/resize、编码和跨场景一致性仍待补测，因此本 Step 尚未完成。

### Step 0.4 — 跨平台进程与路径 Spike

- [x] 验证 Windows native 下 direct spawn、`.cmd`/`.exe` 解析和 process tree 清理；Ctrl+C/ Ctrl+Break 仍待 wrapper 实验。
- [x] 验证至少一个第二目标环境（WSL2）。
- [x] 定义 `nativePath`、`canonicalPath`、`displayPath` 的职责与转换边界。
- [x] 明确 WSL/Windows 路径只在 platform package 中转换。
- [ ] 记录 PTY 是否为 V0 必需；当前仅明确 non-interactive structured path 可先行，交互式 passthrough 待 Claude/Codex TTY 实验。

**产物/验证：** `docs/findings/process-platform.md`；选定可实现且不会破坏原 CLI 语义的 V0 wrapper 策略。

### Step 0.5 — 冻结 V0 Capability Matrix

- [ ] 为每个 adapter 填写 `structuredEvents/toolCalls/fileEvents/commandEvents/tokenUsage/sessionInfo/milestones`。
- [ ] 为每项 capability 记录来源、置信度、限制和 fallback observer。
- [ ] 决定 AgentScope sessionId 始终自生成，provider session id 只作为可选 metadata。
- [ ] 把 Codex App 调研放入 V1，不作为 V0 blocker。

**Phase 0 门禁：** 两个 CLI 的当前真实行为已有可复现实验和脱敏样例；任何未知项都被显式标记，不会被硬编码成稳定协议。

---

## Phase 1 — Monorepo 工程基座

**目的：** 建立所有后续模块共享的可重复开发、测试和构建环境。

### Step 1.1 — 初始化 workspace

- [x] 初始化根 `package.json`、`pnpm-workspace.yaml` 和 lockfile。
- [x] 建立 `apps/*`、`packages/*`、`docs/*`、`tests/fixtures/*` 目录。
- [x] 设置 Node.js 22+ 与 pnpm 版本约束。
- [x] 配置统一 TypeScript base config，开启 strict、noUncheckedIndexedAccess 等安全选项。
- [x] 统一 ESM/CJS 策略、package exports 和内部包引用规则。

### Step 1.2 — 统一质量工具

- [x] 配置 formatter、linter 和 import boundary 规则。
- [x] 配置 Vitest workspace，分离 unit、integration、manual-smoke。
- [x] 根脚本提供 `lint`、`typecheck`、`test`、`test:integration`、`build`、`dev`。
- [x] 加入 `test:changed` 或 package-scoped 命令，缩短迭代反馈。
- [x] 配置覆盖率报告；优先保证 reducer、协议、估算器分支覆盖。

### Step 1.3 — 建立配置、日志与错误约定

- [x] 定义结构化日志接口、level 和敏感字段 redact 规则。
- [x] 定义 typed error/code，区分用户输入错误、provider 错误、存储错误和内部错误。
- [x] 定义配置加载优先级：CLI flag > 环境变量 > config file > defaults。
- [x] 创建 `packages/shared`，只放真正跨层的最小工具，防止变成杂物包。

### Step 1.4 — 建立 CI 基线

- [x] CI 在无真实 Claude/Codex 的环境安装、lint、typecheck、unit test、build。
- [x] 默认 CI 禁止调用真实 Agent；真实 CLI smoke 使用显式 opt-in job。
- [x] fixture 中加入敏感信息扫描或审查脚本。
- [x] 缓存 pnpm store，但不缓存本地数据库或原始日志。

**Phase 1 门禁：** 全新 clone 后可用文档化命令安装和验证；空实现的 lint、typecheck、test、build 全部通过。

---

## Phase 2 — Unified Protocol

**目的：** 先建立小而稳定的统一契约，后续所有模块围绕该契约演进。

### Step 2.1 — 定义事件与来源模型

- [x] 实现 `AgentEventType` 的 V0 最小集合。
- [x] 实现 `AgentEvent<T>`、`source`、`confidence`、`rawRef`。
- [x] 为常用事件定义 typed payload；未知 provider 字段留在 adapter 内或 metadata。
- [x] 约定 timestamp 单位、id 生成、sessionId 所有权和 sequence 语义。
- [x] 明确 `session_finished` payload 如何表达 exitCode、reason 和 provider outcome。

### Step 2.2 — 定义 Adapter 契约

- [x] 实现 `AgentCapabilities`、`DetectionResult`、Start/Attach request。
- [x] `AttachedSession` 提供 async event stream 或一致的 subscribe API。
- [x] 定义 `stop`、`detach`、正常结束、异常结束和重复 cleanup 的语义。
- [x] 规定 adapter 不直接写 DB、不直接修改 SessionState。
- [x] 定义 capability 与单个事件 confidence 的区别。

### Step 2.3 — 定义 SessionState

- [x] 实现 starting/running/blocked/completed/failed/interrupted 状态联合类型。
- [x] 定义 Activity、Milestone、WorkspaceState、VerificationState。
- [x] 定义 ProgressResult 和 ETAResult，统一 reasons 的机器可读 code 与人类可读 message。
- [x] 定义状态不变量：endedAt 只用于终态、终态不可被普通活动事件重新打开等。

### Step 2.4 — 运行时校验与序列化

- [x] 为 API、fixture、DB 读取边界添加 runtime schema validation。
- [x] 测试 JSON serialize/deserialize，避免 `undefined`、Date、BigInt 等不稳定值。
- [x] 对未知事件类型和新增 payload 字段制定 forward-compatible 行为。
- [x] 加入 schema/protocol version；明确 V0 内允许的兼容演进方式。

### Step 2.5 — 协议文档与测试

- [x] 编写 `docs/event-protocol.md`，包含事件表、payload 示例、状态不变量。
- [x] 为每类核心事件加入合法/非法样例测试。
- [x] 测试 confidence 边界、缺失字段、非法 timestamp、重复 id（跨事件保留/丢弃策略由 Phase 3 Core 负责）。
- [x] 建立 golden JSON，防止无意破坏公开协议。

**Phase 2 门禁：** 协议包可独立构建；Core 不需要 provider 类型即可消费事件；schema validation、serialization 和 basic compatibility 测试通过。

---

## Phase 3 — Core State Engine + MockAdapter

**目的：** 不依赖真实 Agent，先跑通事件到状态的确定性转换和完整生命周期。

### Step 3.1 — 实现 EventBus

- [x] 支持按 session 发布/订阅和全局订阅。
- [x] 规定同步/异步 delivery、订阅者异常隔离和 backpressure 策略。
- [x] 返回 unsubscribe/cleanup handle，避免 listener 泄漏。
- [x] 测试多个 session 并发、订阅取消和单个订阅者抛错。

### Step 3.2 — 实现事件接纳管线

- [x] 校验 event schema、session ownership 和 timestamp 合理性。
- [x] 为每个 session 分配单调递增 `seq`。
- [x] 按 event id 去重，定义重复事件返回结果。
- [x] 定义 out-of-order timestamp 的保留与 state reduction 策略。
- [x] 将“持久化成功后再广播”确定为一致性原则，避免 UI 看到未落库事件。

### Step 3.3 — 实现 Session reducer

- [x] 实现 starting → running → terminal 的合法状态转换表。
- [x] 实现 blocked/unblocked，保留阻塞原因和累计阻塞信息。
- [x] 根据 tool/command/file/test 事件更新 currentActivity。
- [x] 根据 milestone 事件维护 milestones，并处理重复完成和非法顺序。
- [x] 根据 test/build/typecheck 事件更新 VerificationState。
- [x] 将 exit code、用户中断和 adapter error 映射到正确终态。
- [x] 保证 reducer 纯函数、可重放、相同输入产生相同结果。

### Step 3.4 — 实现 MockAdapter 与 fixture runner

- [x] 实现 basic-success、test-failure、blocked-then-resumed、interrupted、low-signal fixtures。
- [x] 支持可配置速度和 deterministic timestamps。
- [x] fixture runner 将原始 mock step 转换为 AgentEvent stream。
- [x] MockAdapter 声明完整 capability，用于测试 UI 的 richer path。
- [x] 增加低 capability fixture，用于测试降级体验。

### Step 3.5 — Core 测试

- [x] 覆盖正常完成、失败、中断、阻塞解除和 verification failed。
- [x] 覆盖 duplicate、out-of-order、late event、terminal 后事件。
- [x] 覆盖多 session 隔离和资源 cleanup。
- [x] 用相同事件日志重放两次，断言最终 state 完全一致。

**Phase 3 门禁：** Mock fixture 能驱动 session 从 start 到 terminal；reducer/lifecycle/ordering/dedupe 测试全部通过，且没有真实 CLI/DB/UI 依赖。

---

## Phase 4 — SQLite Storage + HTTP/WebSocket Server

**目的：** 形成可持久化、可查询、可实时订阅、可断线恢复的数据服务。

### Step 4.1 — 设计 schema 与 migration

- [x] 完成 SQLite driver spike：选择 `better-sqlite3`，证据记录在 `docs/findings/sqlite-driver.md`。
- [x] 建立 sessions、events、milestones、eta_snapshots 表。
- [x] events 添加 `(session_id, seq)` unique constraint。
- [x] 为 `session_id/seq/timestamp/type` 和 session status/project 建索引。
- [ ] payload/metadata/reasons 使用 JSON text，读取时做协议校验（JSON 列已建，读取校验待 repository 层）。
- [x] 配置 SQLite WAL、busy timeout 和外键。
- [ ] 建立 migration 命令及空库/旧库升级测试（命令与空库幂等测试已完成，旧库升级测试待补）。

### Step 4.2 — 实现 repositories 与事务

- [x] 实现 session create/update/get/list。
- [x] 实现 append event、cursor pagination 和 timeline 查询。
- [x] 实现 milestones、ETA snapshot 写入与查询。
- [x] 将 event append 与 session projection 更新放入同一事务。
- [x] 定义重复事件、数据库 busy、损坏 payload 的错误处理。

### Step 4.3 — 实现服务启动恢复

- [ ] 启动时加载非终态 session，并按事件重放或 projection 校验。
- [x] 对服务崩溃遗留的 starting/running session 标记为 `interrupted`；blocked session 保留等待用户动作。
- [ ] 比较持久化 projection 与 replay 结果，发现不一致时记录诊断信息。
- [ ] 优雅关机时停止接受新事件、flush 写入、关闭 DB。

### Step 4.4 — 实现 HTTP API

- [x] `GET /api/sessions`：过滤 project/status、稳定分页和摘要。
- [x] `GET /api/sessions/:id`：返回 state、capability、workspace 和 verification。
- [x] `GET /api/sessions/:id/events?after=<cursor>`：按 seq 返回事件与 next cursor。
- [x] `GET /api/projects/:id/overview`：聚合 active/blocked/completed counts。
- [x] 为 400/404/409/500 定义一致错误 envelope。
- [x] 对 request/response 做 TypeBox schema 校验；API 文档生成仍待接入。

### Step 4.5 — 实现 WebSocket 协议

- [x] 提供 `/ws`，定义 connection hello/protocol version。
- [x] 广播 `session.created/session.updated/event.appended`；`project.updated` 待 project write path 接入。
- [x] `event.appended` 携带 sessionId、seq/cursor 和必要的轻量 payload；session 级消息携带 sessionId 与状态 payload。
- [x] 设计 subscribe/filter，避免所有项目事件无条件发送给每个客户端。
- [ ] 实现 heartbeat、断开 cleanup、慢客户端处理和消息大小限制（断开和发送失败 cleanup 已完成，heartbeat/size limit 待完成）。
- [x] 文档化并用集成测试验证“WS 只负责实时，HTTP cursor 负责补齐”的恢复流程。

### Step 4.6 — Server 集成测试

- [x] 临时 SQLite 中写入事件并通过 HTTP 查询。
- [x] 重启 server 后仍能查询历史 timeline。
- [ ] 测试并发 append 的 seq 唯一和顺序。
- [x] 测试 WS 收到实时事件，断开期间写入后通过 HTTP cursor 补齐。
- [ ] 测试 malformed payload、未知 session、DB failure 和优雅关闭。

**Phase 4 门禁：** Mock 事件可持久化并实时推送；server 重启和 WS 重连不会丢失已确认写入的 timeline。

---

## Phase 5 — CLI 与 Process Lifecycle

**目的：** 提供稳定入口，并尽量不改变被包装 Agent 的原始交互和退出语义。

### Step 5.1 — CLI 命令骨架

- [ ] 实现 `agent-scope start`。
- [ ] 实现 `agent-scope run <adapter> -- <args...>`，严格保留 `--` 后参数边界。
- [ ] 实现 `agent-scope sessions` 和 `agent-scope show <session-id>`。
- [ ] 实现 `agent-scope run mock --fixture <name>`。
- [ ] 统一 help、错误码和 non-interactive 输出格式。

### Step 5.2 — 子进程 wrapper

- [ ] 使用 `spawn(executable, args)`，不进行通用 shell 拼接。
- [ ] 明确 inherited、piped 和 structured 模式下 stdin/stdout/stderr 的策略。
- [ ] 原 CLI 输出保持原样；解析副本不得重复打印到 server log。
- [ ] 捕获 pid、start/end、exit code、signal 和 spawn error。
- [ ] 处理 Ctrl+C、Ctrl+Break、父进程退出和 process tree cleanup。
- [ ] 处理 Windows executable resolution、空格路径、Unicode 路径和长参数。
- [ ] AgentScope CLI 返回与被包装 CLI 一致或文档化映射后的 exit code。

### Step 5.3 — Session 注册与生命周期连接

- [ ] wrapper 启动前创建 starting session。
- [ ] 子进程成功 spawn 后产生 session_started。
- [ ] 将 adapter event stream 和 ProcessObserver 接入事件接纳管线。
- [ ] 正常结束、非零退出、用户中断、spawn 失败分别生成明确事件。
- [ ] 保证任何路径最终都执行 detach/stop/watcher/stream cleanup。

### Step 5.4 — `start` 的运行模式

- [ ] 决定开发态和发布态下 server/dashboard 的启动方式。
- [ ] 处理端口占用、已有 server、DB 路径、浏览器是否自动打开等场景。
- [ ] 提供 health/readiness endpoint，CLI 可等待服务就绪。
- [ ] 服务不可用时 `run` 给出可操作错误，不静默丢事件。

### Step 5.5 — CLI 测试

- [ ] 用 synthetic child process 测试 stdout/stderr、exit 0/非 0、长运行和中断。
- [ ] 测试带空格/Unicode 的 cwd 和参数。
- [ ] 测试 cleanup 幂等、孤儿进程防护和 server unavailable。
- [ ] 真实 TTY 行为纳入 manual smoke checklist。

**Phase 5 门禁：** Mock 和 synthetic process 的 I/O、退出码、状态映射均正确；wrapper 不明显破坏被包装 CLI 的使用体验。

---

## Phase 6 — 最小 React Dashboard

**目的：** 尽早完成 capture → UI 的纵向闭环，先保证信息可信与实时，不做复杂图表。

### Step 6.1 — 前端基座与 API client

- [ ] 初始化 React + Vite + TypeScript + Tailwind。
- [ ] 建立 typed HTTP/WS client，复用 protocol schema 或生成的 DTO。
- [ ] 实现 loading、empty、error、offline/reconnecting 状态。
- [ ] 统一时间、持续时长、confidence 和 ETA range 格式化。

### Step 6.2 — Project overview

- [ ] 展示 active/blocked/completed/failed counts。
- [ ] 按最近活动排序 session，提供基本 status filter。
- [ ] AgentCard 展示 provider/client/environment、status、elapsed、currentActivity、last event。
- [ ] 展示 progress/ETA 占位或真实结果，并始终显示 confidence。
- [ ] 标出 native、wrapped、inferred 等信息来源。

### Step 6.3 — Session detail

- [ ] 展示按 seq 排序的 timeline。
- [ ] 展示 milestones、verification、changed files、recent commands。
- [ ] 为 error、blocked、test_failed 等高价值事件提供醒目但不夸张的状态。
- [ ] 对 capability 缺失做解释性降级，不展示误导性的空模块。
- [ ] 限制大 timeline 的初始加载量，支持 cursor 加载更多。

### Step 6.4 — 实时更新与断线恢复

- [ ] 首次进入先 HTTP snapshot，再连接 WS。
- [ ] 保存各 session 最后 seq；收到 WS 消息时去重并检测 gap。
- [ ] gap 或重连后用 `events?after=` 补齐，再继续实时订阅。
- [ ] 更新 reducer/cache 时防止重复事件导致 UI 抖动。
- [ ] 显示连接状态，但不把短暂重连误报为 session 阻塞。

### Step 6.5 — Dashboard 测试

- [ ] component test 覆盖主要状态和 capability 降级。
- [ ] MockAdapter 同时运行两个 session，验证卡片实时更新。
- [ ] smoke test 覆盖 overview → detail → timeline。
- [ ] 模拟 WS 断线和事件 gap，验证补齐后无重复无缺失。
- [ ] 做基本 keyboard/focus、颜色对比和窄屏检查。

**Phase 6 门禁：** 两个 Mock session 可同时实时展示；进入详情可查看完整 timeline；重连后 UI 与数据库状态一致。

---

## Phase 7 — Claude Code Adapter

**目的：** 按 Phase 0 的真实能力接入 Claude Code，不把 provider 细节泄漏到 Core。

### Step 7.1 — 检测与 capability

- [ ] 实现 executable/version 检测和可读诊断。
- [ ] 根据实测模式返回 capability，不夸大无法稳定捕获的事件。
- [ ] 将 provider session id、版本、模式存为可选 metadata。

### Step 7.2 — 启动与解析

- [ ] 构造参数数组，选择 Phase 0 确认的 structured 首选模式。
- [ ] 增量解析 chunk/line，正确处理跨 chunk JSON、CRLF、Unicode 和 malformed record。
- [ ] 将公开稳定事件映射为 AgentEvent。
- [ ] structured 不可用时降级为 lifecycle + stdout/stderr 文本提示 + workspace signals。
- [ ] 未知 provider 事件安全忽略或记录低敏诊断，不让 adapter 崩溃。

### Step 7.3 — 生命周期与隐私

- [ ] provider outcome 与进程 exit code 冲突时按文档化规则判定状态。
- [ ] 用户中断必须映射为 interrupted，而非 failed/completed。
- [ ] 默认不保存完整文本、prompt 或 raw output；rawRef 仅在明确启用且脱敏时使用。
- [ ] adapter stop/detach 可重复调用且不泄漏子进程/stream。

### Step 7.4 — 测试与文档

- [ ] raw fixture → normalized events golden tests。
- [ ] 覆盖 malformed、未知事件、部分输出、非零退出和中断。
- [ ] 运行真实 manual smoke，并记录版本、命令、结果和限制。
- [ ] 更新 capability matrix 和用户文档。

**Phase 7 门禁：** 至少一个真实 Claude Code session 被监控；fixture tests 稳定；原生不可用时仍可退化到 wrapped/external signals。

---

## Phase 8 — Codex CLI Adapter

**目的：** 用与 Claude 同一契约接入 Codex CLI，并严格隔离 Codex-specific parsing。

### Step 8.1 — 检测与 capability

- [ ] 实现 executable/version 检测和错误诊断。
- [ ] capability 只反映当前实测的公开稳定能力。
- [ ] provider session id 若不可获得，继续使用 AgentScope sessionId。

### Step 8.2 — 启动与解析

- [ ] 使用 Phase 0 确认的 JSON/structured/exec 模式，不硬编码旧事件名。
- [ ] 实现增量 parser，处理 chunk boundary、CRLF、Unicode、mixed text 和 malformed JSON。
- [ ] 把稳定事件映射为统一 tool/file/command/message/lifecycle 事件。
- [ ] 内部实现字段不提升为 protocol contract。
- [ ] structured 路径失败时降级为 process + workspace observer。

### Step 8.3 — 生命周期与隐私

- [ ] 正确处理正常完成、非零退出、provider error 和用户中断。
- [ ] 避免原 stdout 被 server log 重复记录。
- [ ] 对 message/tool payload 做最小化和敏感字段过滤。
- [ ] 确保 stream、process 和 timer 在所有路径 cleanup。

### Step 8.4 — 测试与文档

- [ ] raw fixture → normalized events golden tests。
- [ ] 覆盖 unknown event、partial record、failure、interrupt 和 fallback。
- [ ] 运行真实 manual smoke 并记录能力边界。
- [ ] 更新 capability matrix、adapter guide 和 troubleshooting。

**Phase 8 门禁：** 至少一个真实 Codex CLI session 被监控；Codex-specific 代码完全位于 adapter 包；与 Claude session 可同时运行。

---

## Phase 9 — Workspace Observers

**目的：** 用客观环境信号补强原生事件，在 adapter 能力不足时仍提供可靠活动与验证信息。

### Step 9.1 — ProcessObserver

- [ ] 只观察 wrapper 启动的进程树，记录 pid/start/end/exit code 和必要 metadata。
- [ ] 不枚举或采集不相关进程、命令行和环境变量。
- [ ] 处理子进程快速退出、父子顺序反转和 cleanup race。
- [ ] 输出统一 lifecycle/command evidence，不与 adapter 事件重复计数。

### Step 9.2 — GitObserver

- [ ] 识别 cwd-scoped Git repo、branch、HEAD 和初始 dirty baseline。
- [ ] 使用稳定 machine-readable git 输出解析 changed files 和 diff stat。
- [ ] 只在事件触发或合理间隔采样，避免频繁全量 diff。
- [ ] 区分 session 前已有修改和 session 期间新增修改。
- [ ] Git 不可用、非仓库、submodule/worktree 等场景安全降级。

### Step 9.3 — FileObserver

- [ ] watcher 根目录固定为 workspace resolved path。
- [ ] 尊重 `.gitignore`、默认 ignore 和可配置 ignore。
- [ ] 默认排除 `.git`、`node_modules`、build output、大型缓存和 AgentScope DB。
- [ ] 对 create/modify/delete debounce、coalesce，防止事件风暴。
- [ ] 防御 symlink/path traversal，确保事件仍属于 workspace。
- [ ] 只记录路径和必要 stat，不默认读取文件内容。

### Step 9.4 — TestObserver

- [ ] 建立常见 test/build/lint/typecheck 命令规则表。
- [ ] 优先消费 wrapper/adapter 已知 command event，不尝试解析任意 shell。
- [ ] 记录 command kind、start/end、exit code、duration 和可选摘要。
- [ ] 成功映射为 verification passed，失败映射为 failed；未知命令保持 generic。
- [ ] 防止同一命令被 adapter 与 observer 双重计数。

### Step 9.5 — Observer 融合与测试

- [ ] 定义 native > process/test > git/file > agent self-report 的证据优先级。
- [ ] 为 inferred 事件设置较低 confidence 和明确 reason/source。
- [ ] 临时 Git repo 测试 baseline、modify、delete、commit 和非仓库。
- [ ] synthetic test command 覆盖 pass/fail/interrupt。
- [ ] 压测事件风暴下 debounce、批量写入和 CPU/IO 开销。

**Phase 9 门禁：** 关闭 adapter rich events 后，Mock/真实 wrapper 仍能展示进程、文件/Git 和验证活动；observer 不越出 workspace、不采集敏感数据。

---

## Phase 10 — Progress Engine V0

**目的：** 提供确定性、可解释、允许回退且不制造“虚假完成”的进度。

### Step 10.1 — 配置阶段模型

- [ ] 将 planning 0.10、implementation 0.50、unit verification 0.15、integration/build 0.15、final review 0.10 放入集中配置。
- [ ] 定义项目无某类验证时权重如何重分配，不能直接无条件送满分。
- [ ] 定义 milestone 显式权重的校验、归一化和异常 fallback。
- [ ] 定义没有 milestone 时的隐式阶段 heuristic 和 confidence penalty。

### Step 10.2 — 聚合证据

- [ ] 输入 SessionState、milestones、capabilities、workspace 和 verification。
- [ ] 区分原生事件、observer 推断和 Agent 自报证据。
- [ ] 记录每次计算使用了哪些 evidence，以及 freshness。
- [ ] 对重复/冲突信号按来源优先级去重和裁决。

### Step 10.3 — 计算 value/confidence/reasons

- [ ] 仅实现完成时 progress 上限默认 0.60。
- [ ] 有验证要求而尚未验证时禁止到 1.0。
- [ ] verification failed、blocked、replanning 可以使 value 回退。
- [ ] session_finished 但 verification failed 时状态为 failed，不能显示成功 100%。
- [ ] confidence 综合 capability、milestone availability、event freshness 和 signal density。
- [ ] reasons 输出稳定 reason code、展示文本和关联 evidence。

### Step 10.4 — 测试典型路径

- [ ] basic success：规划→实现→unit→integration→review→完成。
- [ ] implementation only：不超过实现上限。
- [ ] failed test：progress 回退或停滞且理由明确。
- [ ] blocked/unblocked：阻塞时不假装继续增长。
- [ ] replan：新 milestone 引起合理回退。
- [ ] no milestone/low capability：数值可用但 confidence 较低。
- [ ] completed with failed verification：failed 且非成功 100%。
- [ ] 配置边界、非法权重和 deterministic replay。

### Step 10.5 — 接入 state/API/UI

- [ ] 每个关键事件后重新计算，避免按固定时间假增长。
- [ ] 将结果作为 session projection 持久化或可重建字段。
- [ ] API 返回完整 reasons；overview 可返回摘要。
- [ ] UI 展示数值、confidence 和主要原因，不只显示进度条。

**Phase 10 门禁：** 所有约束都有单元测试；验证前不会 100%；失败/阻塞/replan 可回退；相同事件重放得到相同结果。

---

## Phase 11 — ETA Engine V0

**目的：** 基于进度和风险给出宽诚实的时间区间，而不是伪精确单点。

### Step 11.1 — 实现基础估计

- [ ] 实现 `elapsed / max(progress, MIN_PROGRESS) * (1 - progress)`。
- [ ] progress 低于阈值（建议初始 0.08）时返回 insufficient_data 或极宽范围。
- [ ] 处理 elapsed=0、progress=0/1、终态和异常输入。
- [ ] 所有阈值和区间系数集中配置。

### Step 11.2 — 实现风险倍率

- [ ] failedTestPenalty 随失败次数和最近结果变化。
- [ ] blockerPenalty 结合当前阻塞与累计阻塞时长。
- [ ] lowSignalPenalty 结合 capability、freshness 和 event density。
- [ ] replanningPenalty 结合新增/重置 milestone。
- [ ] verification pending 进入 reasons，并影响区间/置信度。
- [ ] penalty 设合理上下界，防止数值爆炸但允许 ETA 上升。

### Step 11.3 — 生成 range/confidence/reasons

- [ ] center 只作为内部值，不在 UI 伪装为精确 ETA。
- [ ] confidence 越低，min/max 区间越宽。
- [ ] 输出 min/max 顺序、最小显示粒度和最大可显示范围。
- [ ] 终态返回 zero/not_applicable，而不是残留旧 ETA。
- [ ] reasons 至少覆盖 failed tests、blocked、no native events、verification pending、insufficient data。

### Step 11.4 — Snapshot 与展示

- [ ] 在显著变化、关键事件或合理节流间隔写入 eta_snapshots。
- [ ] 避免每个 file event 都写 snapshot 造成数据库膨胀。
- [ ] API 返回当前 ETA 和可选历史；V0 UI 先展示当前区间与原因。
- [ ] 预留后续曲线接口，但不在 V0 优先做复杂图表。

### Step 11.5 — ETA 测试

- [ ] early low-data：不输出误导性的具体分钟。
- [ ] normal progress：范围随有效进展整体收敛。
- [ ] failed tests：ETA 可增大、confidence 可下降。
- [ ] blocker：区间显著变宽或标记 paused/uncertain。
- [ ] low capability/stale events：低 confidence、宽区间。
- [ ] completion/failure/interruption：终态输出正确。
- [ ] deterministic replay 和配置边界。

**Phase 11 门禁：** ETA 始终以区间、confidence、reasons 表达；测试失败或阻塞后允许变长；早期低数据不会伪精确。

---

## Phase 12 — 端到端集成、加固与 V0 发布

**目的：** 将各模块作为真实产品验证，补齐跨平台、性能、安全、文档和发布证据。

### Step 12.1 — Mock E2E

- [ ] 从 `agent-scope start` 启动完整系统。
- [ ] 同时运行 success 与 blocked/test-failure 两个 Mock session。
- [ ] 验证 overview counts、card、detail、timeline、progress、ETA 实时变化。
- [ ] 刷新 Dashboard、断开 WS、重启 server，验证历史和补齐逻辑。
- [ ] 将该流程纳入默认 CI smoke。

### Step 12.2 — 真实双 Agent smoke

- [ ] 在脱敏测试仓库启动一个 Claude Code CLI session。
- [ ] 同时启动一个 Codex CLI session。
- [ ] 验证两者 I/O、退出码、状态、timeline 与 workspace signals。
- [ ] 测量关键事件端到端延迟，P95 目标小于 3 秒。
- [ ] 记录 provider 版本、操作系统、模式和已知限制。

### Step 12.3 — 状态与故障注入

- [ ] 注入 non-zero exit、Ctrl+C、adapter parser error、server restart、DB busy、WS disconnect。
- [ ] 验证不会把 failed/interrupted/completed 混淆。
- [ ] 验证 parser/observer 故障不会拖垮其他 session。
- [ ] 验证事务失败时不广播幽灵事件。
- [ ] 验证重复 cleanup 不报错、不遗留进程/端口/watcher。

### Step 12.4 — 性能与容量基线

- [ ] 至少测试 4 个并发 Mock session 和高频 file events。
- [ ] 记录事件写入吞吐、UI 延迟、内存、CPU、DB 增长速度。
- [ ] 确认 debounce、WS backpressure 和 timeline pagination 有效。
- [ ] 给出 V0 支持的合理 session/event 数量边界，不作无证据承诺。

### Step 12.5 — 安全与隐私审查

- [ ] 检查 DB、logs、fixtures、API 是否出现 env、token、secret、完整 prompt。
- [ ] 检查 workspace 边界、symlink、path traversal 和任意文件读取风险。
- [ ] 检查 CLI 参数处理，确保不发生 shell injection。
- [ ] 默认仅监听 loopback；若支持外部 bind，必须明确风险和配置。
- [ ] raw log opt-in 有醒目提示、路径限制和清理策略。

### Step 12.6 — 跨平台加固

- [ ] 在主目标环境执行完整 Mock E2E。
- [ ] 在至少一个第二目标环境执行 CLI/process smoke。
- [ ] 检查 Windows/WSL 路径、Unicode、空格、信号和 process tree。
- [ ] 将未覆盖平台标记为 experimental，不模糊宣称支持。

### Step 12.7 — 文档与发布体验

- [ ] README：产品定位、安装、quick start、截图/示例、限制。
- [ ] `docs/adapter-guide.md`：用 ExampleAdapter 验证扩展性。
- [ ] 配置参考：端口、DB、log level、ignore、raw log、heuristic 参数。
- [ ] troubleshooting：CLI detection、端口、DB lock、WS、TTY、Windows/WSL。
- [ ] manual smoke checklist 和 fixture 更新指南。
- [ ] 版本号、changelog、migration 和回滚/备份说明。

### Step 12.8 — V0 验收签字

- [ ] 逐项运行第 8 节验收追踪表，附命令、测试报告、截图或文档链接。
- [ ] 所有 P0/P1 bug 已关闭；剩余限制进入 Known Issues。
- [ ] 验证 ExampleAdapter 不需要修改 Core/Storage/Dashboard 关键逻辑。
- [ ] 生成 V0 release notes，明确支持矩阵和非目标。

**Phase 12 门禁：** V0 所有验收标准有可重复证据；无已知数据丢失、状态误判或敏感信息默认泄漏问题。

---

## 5. 横向工作流（贯穿所有 Phase）

### 5.1 测试策略

| 层 | 必测内容 | 运行时机 |
|---|---|---|
| Protocol | schema、序列化、非法输入、基础兼容 | 每次协议改动 |
| Core | reducer、lifecycle、ordering、dedupe、replay | 每次状态逻辑改动 |
| Adapter | raw fixture → normalized golden events | 每次 parser 改动 |
| Observer | 临时 repo、synthetic process/file/test | 每次 observer 改动 |
| Progress | success/fail/block/replan/low-signal | 每次 heuristic 改动 |
| ETA | early/normal/fail/block/terminal | 每次 estimator 改动 |
| Server | DB transaction、API、WS reconnect/catch-up | 每次 API/storage 改动 |
| Dashboard | 状态展示、gap recovery、降级路径 | 每次 UI/data flow 改动 |
| E2E | Mock 全链路 | 每个 Phase 门禁及 CI |
| Manual smoke | 真实 Claude/Codex、TTY、跨平台 | adapter 或发布候选版本 |

### 5.2 可观测性与诊断

- [ ] AgentScope 自身日志包含 request/session correlation id，但不复制原始 Agent 输出。
- [ ] 暴露 health/readiness 和 DB/schema version。
- [ ] 为 dropped/invalid/duplicate events、WS clients、write latency 建立轻量指标。
- [ ] 所有降级路径产生可诊断 reason，不静默降低数据质量。

### 5.3 协议与数据库演进

- [ ] 对外事件字段先少后稳；新增字段优先 optional。
- [ ] breaking protocol change 必须提升版本并提供兼容/迁移说明。
- [ ] 数据库变更只通过 migration，不在启动代码中临时拼 schema。
- [ ] raw fixture 和 golden normalized fixture 与 adapter 版本变化同步更新。

### 5.4 完成定义（适用于每个 Step）

一个 Step 只有同时满足以下条件才能勾选：

- 实现已完成，且没有用 TODO 掩盖该 Step 的核心行为。
- 相关 unit/integration/smoke 测试通过。
- 错误、cleanup、隐私和跨平台边界已考虑。
- 对外契约或用户行为变化已更新文档。
- 变更范围清晰，可独立 review；未混入无关重构。

## 6. V0 验收追踪表

| ID | 验收条件 | 主要实现 Phase | 验证证据 |
|---|---|---|---|
| AC-01 | `agent-scope start` 后 Dashboard 可访问 | 4、5、6 | CLI smoke + browser/E2E |
| AC-02 | 两个 Mock session 在 UI 同时实时展示 | 3、4、6 | CI E2E |
| AC-03 | 一个真实 Claude 和一个真实 Codex session 可监控 | 7、8、12 | manual dual-agent smoke |
| AC-04 | 关键事件本地延迟 < 3 秒 | 4、6、12 | latency measurement |
| AC-05 | exit code、interrupted、failed、completed 不混淆 | 3、5、7、8 | lifecycle tests + fault injection |
| AC-06 | Progress 含 value/confidence/reasons，验证前不 100% | 10 | unit + E2E |
| AC-07 | ETA 含 min/max/confidence/reasons，失败后可变长 | 11 | unit + E2E |
| AC-08 | SQLite 保存并重载历史 session | 4 | restart integration test |
| AC-09 | Dashboard 重连后 timeline 不丢失 | 4、6 | WS gap/catch-up test |
| AC-10 | ExampleAdapter 不改关键核心逻辑 | 2、3、12 | adapter guide exercise |

## 7. 关键风险、触发信号与应对

| 风险 | 触发信号 | 应对与降级 |
|---|---|---|
| CLI structured output 不稳定 | 版本升级导致 fixture/parser 失败 | 版本检测、golden fixtures、capability 降级到 process/workspace signals |
| interactive 与 structured 冲突 | TTY 丢失、stdin 不可用、输出语义改变 | V0 明确优先 non-interactive path；文档化限制；PTY 单独 spike |
| 事件重复或乱序 | state 抖动、重复 timeline、seq gap | event id 去重、server 分配 seq、reducer 可重放、UI gap recovery |
| Progress 虚假精确 | 无验证仍接近/达到 100% | 实现上限、验证保留权重、confidence/reasons、允许回退 |
| ETA 剧烈误导 | 早期给出窄范围、失败后仍下降 | insufficient_data、风险 penalty、低信号宽区间、snapshot 回归测试 |
| 文件监听开销高 | CPU/IO 飙升、DB 快速增长 | workspace 限制、ignore、debounce、coalesce、批量写入、容量基线 |
| 隐私泄漏 | logs/DB/fixture 出现 prompt/token/env | 默认关闭 raw、redaction、fixture 审查、最小 payload、loopback server |
| Windows/WSL 行为差异 | 路径无法匹配、Ctrl+C 后孤儿进程 | platform abstraction、真实 smoke、明确支持矩阵和 experimental 标签 |
| SQLite 并发/锁 | append latency/DB busy | WAL、busy timeout、短事务、单写入队列或批处理、故障测试 |
| Dashboard 与 DB 不一致 | WS 断线后缺事件或重复 | persist-before-publish、seq/cursor、HTTP catch-up、去重 |

## 8. 待决策清单（最迟关闭时间）

| 决策 | 候选 | 最迟关闭 | 选择标准 |
|---|---|---|---|
| HTTP framework | Fastify / 等价轻量框架 | Phase 1 | schema、WS、测试生态、依赖体积 |
| SQLite 访问层 | Drizzle / 等价轻量方案 | Phase 1 | migration、事务、类型安全、JSON 灵活度 |
| Runtime schema | Zod / TypeBox / 等价方案 | Phase 2 | Fastify 集成、类型推导、性能 |
| Adapter stream API | AsyncIterable / subscribe | Phase 2 | backpressure、cleanup、测试性 |
| TTY/PTY | inherited stdio / PTY | Phase 0 | structured 模式兼容性和跨平台维护成本 |
| Session projection | 每次持久化 / 事件重放 + checkpoint | Phase 4 | 恢复速度、一致性和实现复杂度 |
| 前端数据层 | 简单 query cache / 自定义 store | Phase 6 | cursor 合并、去重、重连复杂度 |
| ETA snapshot 节流 | 关键事件 / 时间间隔 / 变化阈值 | Phase 11 | 可解释历史与 DB 增长平衡 |

任何决策都应记录成 ADR；如果 Phase 0 实测推翻假设，优先修改能力矩阵和本路线图，而不是用脆弱解析硬凑支持。

## 9. 建议迭代批次

为保持每次变更可验证，建议按以下批次提交/合并：

1. `foundation`: Phase 0 文档骨架 + Phase 1 工程基座。
2. `protocol`: Phase 2 协议、schema、golden fixtures。
3. `mock-core`: Phase 3 EventBus/reducer/MockAdapter。
4. `persistence-api`: Phase 4 SQLite、API、WS、恢复。
5. `cli-wrapper`: Phase 5 CLI/process lifecycle。
6. `dashboard-slice`: Phase 6 Mock 全链路 UI。
7. `claude-adapter`: Phase 7，独立 fixture 和 smoke 证据。
8. `codex-adapter`: Phase 8，独立 fixture 和 smoke 证据。
9. `workspace-signals`: Phase 9 observers 与融合。
10. `progress`: Phase 10 可解释进度。
11. `eta`: Phase 11 区间估计与 snapshots。
12. `v0-hardening`: Phase 12 E2E、跨平台、隐私、发布文档。

## 10. V1+ Backlog（不进入 V0 关键路径）

- Codex App 的官方/稳定可观测接口 spike；若无接口，仅做 External Level C。
- IDE Agent、Kimi/Gemini CLI、Docker、SSH/remote adapters。
- Project/session group 与 Planner/Worker 多 Agent 编排集成。
- 4+ session 的高级筛选、通知、阻塞告警和历史回放。
- token/cost 统计（仅在 provider 有可靠数据时）。
- ETA 历史特征、相似任务、P50/P80 或统计/机器学习模型。
- PostgreSQL、远程 collector、多设备同步、账号与权限。
- timeline 搜索、commit/PR 关联、趋势和成功率分析。

## 11. 下一步（从这里开始执行）

- [x] 先完成 Step 0.1，建立 architecture、privacy 和 ADR 骨架。
- [ ] 并行推进 Step 0.2/0.3 的 CLI 当前版本实测，但原始样例必须脱敏（已记录部分结果；中断/TTY 补测仍待完成）。
- [x] 同时完成 Phase 1 工程基座，使 Phase 0 产生的 fixtures 能立即进入测试。
- [ ] Phase 0 capability matrix 审核通过后冻结 Protocol V0，再开始 Core 实现。

第一条可演示纵向切片应尽快达到：

```text
MockAdapter
  → AgentEvent validation
  → EventBus / Session reducer
  → SQLite transaction
  → HTTP snapshot + WebSocket update
  → Dashboard AgentCard + timeline
```

在这条链路稳定以前，不提前投入复杂 ETA、Codex App、远程执行或视觉美化。
