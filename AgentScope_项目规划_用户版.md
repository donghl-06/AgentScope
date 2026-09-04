# AgentScope 项目规划（用户版）

*跨 Agent / 跨环境的任务进度与 ETA 可观测平台 · 初版需求与实施计划*

## 1. 项目一句话定义

AgentScope 是一个面向 AI Coding Agent 的统一任务监控平台：无论任务运行在 Claude Code CLI、Codex CLI、Codex App，还是未来的 Kimi / Gemini / 自研 Agent 中，都尽可能把“当前在做什么、做到哪一步、是否卡住、测试是否通过、还可能需要多久”转换成统一、可视化、可追踪的状态。

| **核心原则**                                                                                                                                                                                 |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| AgentScope 不把“Agent 自己说完成了多少”当作唯一事实来源，而是同时使用 Agent 原生事件、进程输出、Git/文件变化、测试结果和历史任务数据。主观汇报是增强信息，外部可验证信号才是进度判断的底座。 |

## 2. 为什么要做

- 长任务期间缺乏反馈：Agent 可能连续工作数分钟甚至更久，用户只能看到“Thinking / Running / Reconnecting”。

- 多 Agent 时管理成本急剧上升：同时开多个 Codex/Claude 会话后，很难知道哪个已完成、哪个卡住、哪个正在反复测试。

- “完成百分比”通常不可信：代码写完不等于任务完成，测试、类型检查、构建、Review 往往决定最后 20%～40% 的真实工作量。

- ETA 缺乏依据：不能简单按 token 或已用时间线性外推，需要结合阶段、失败次数、验证状态和历史相似任务。

- 未来多 Agent 编排需要可观测层：Planner 只有知道 Worker 的状态、阻塞和结果，才能真正自动派发后续任务。

## 3. 目标与非目标

| **类别** | **内容**                                                                                                |
|----------|---------------------------------------------------------------------------------------------------------|
| 必须做到 | 统一展示运行状态、阶段进度、最近事件、耗时、测试/构建结果，并提供区间型 ETA。                           |
| 必须做到 | 架构不绑定某一个 Agent；通过 Adapter 接入 Claude Code CLI、Codex CLI，并为 Codex App 保留降级监控路径。 |
| 必须做到 | 支持多会话同时运行，并能从项目级 Dashboard 查看所有 Agent。                                             |
| 希望做到 | 记录历史任务，逐步提高 ETA 估计质量；统计成功率、平均耗时、失败重试、token/cost（有数据时）。           |
| 暂不追求 | 读取或展示 Agent 的私有 chain-of-thought；不依赖 UI OCR；不承诺精确到分钟的 ETA。                       |
| 暂不追求 | V0 即支持所有 Agent/IDE/云端环境。先把两种 CLI 路径做稳，再扩展。                                       |

## 4. 面向用户的核心体验

理想状态下，打开 Dashboard 后可以直接看到：

    PROJECT 清灵
    Overall 71%

    Claude Code · WSL
    [██████████████░░░░] 74%
    当前：修复 authentication integration tests
    Tests: 41 passed / 3 failed
    Elapsed: 18m 32s
    ETA: 8–15m · Confidence: Medium

    Codex CLI · WSL
    [██████████████████░] 91%
    当前：final verification
    ETA: 2–6m

    Codex App · Windows
    [████████░░░░░░░░░░] 43%
    当前：检测到持续文件修改，尚未运行验证
    ETA: 低置信度

点击某个 Agent 后进入详情页：展示时间线、阶段、命令、文件变化、测试结果、阻塞状态和 ETA 变化曲线。

## 5. 产品能力拆解

| **模块**          | **V0**                                      | **后续增强**                                 |
|-------------------|---------------------------------------------|----------------------------------------------|
| Session Monitor   | 发现并展示单个/多个正在运行的 Agent session | 跨机器、远程 session、历史回放               |
| Timeline          | 命令、文件修改、测试、阶段状态              | 搜索、过滤、关联 commit / PR                 |
| Progress Engine   | 基于 milestone + 验证信号计算进度           | 按任务类型学习权重、动态回退                 |
| ETA Engine        | 基于 elapsed、阶段权重、失败/阻塞做区间估计 | 历史相似任务 + 回归/GBDT + 置信区间          |
| Adapter Layer     | Claude Code CLI + Codex CLI                 | Codex App、VS Code、Kimi、Gemini、自研 Agent |
| Environment Layer | Windows / WSL / macOS / Linux 基础识别      | Docker / SSH / Remote / Cloud                |
| Dashboard         | 项目总览、Agent Card、详情 Timeline         | 成本、成功率、趋势、通知                     |
| Storage           | SQLite 本地持久化                           | PostgreSQL / 多设备同步                      |

## 6. 核心架构

    Claude Code CLI ─ ClaudeAdapter ─┐
    Codex CLI ─────── CodexAdapter ───┤
    Codex App ─────── AppAdapter ─────┤
    Other Agent ───── OtherAdapter ───┘
    ↓
    Unified Event Bus
    ↓
    ┌────────────────────┼────────────────────┐
    ↓ ↓ ↓
    State Engine Progress Engine ETA Engine
    └────────────────────┼────────────────────┘
    ↓
    SQLite Store
    ↓
    WebSocket / API
    ↓
    Dashboard

最关键的设计决策：核心层只理解统一 AgentEvent，不直接理解 Claude/Codex 的原始事件。每个 Adapter 负责“翻译”，因此未来接新 Agent 的成本主要落在 Adapter，而不是全系统改造。

## 7. 统一事件模型（概念版）

    AgentEvent {
    sessionId
    timestamp
    source: { provider, client, environment }
    type:
    session_started | planning | tool_call |
    file_read | file_write | command_started | command_finished |
    test_started | test_passed | test_failed |
    milestone_started | milestone_completed |
    blocked | task_completed
    payload
    confidence
    }

不同 Adapter 不必支持全部事件。每个 Adapter 应声明 capability，例如 structuredEvents、toolCalls、fileEvents、commandEvents、tokenUsage、sessionInfo。Dashboard 根据能力自动降级展示。

## 8. 三档可观测性

| **等级**           | **场景**                     | **可获得信息**                                | **预计可靠度**       |
|--------------------|------------------------------|-----------------------------------------------|----------------------|
| Level A · Native   | Agent 提供结构化事件 / hooks | 工具调用、命令、文件、阶段、token/session 等  | 最高                 |
| Level B · Wrapped  | 由 AgentScope 启动 CLI       | stdout/stderr、进程、Git、文件、命令/测试推断 | 高                   |
| Level C · External | Agent 已在 App/IDE 内运行    | Git、文件系统、进程、测试和 repo 状态         | 中等；ETA 置信度较低 |

## 9. Progress 的计算原则

不采用简单“步骤完成数 / 总步骤数”。每个 milestone 有权重，并对验证阶段保留足够比例。建议初始权重：

| **阶段**     | **默认权重** | **说明**                                |
|--------------|--------------|-----------------------------------------|
| 理解/规划    | 10%          | 读代码、明确范围、生成 milestone        |
| 实现         | 50%          | 核心代码和必要配置                      |
| 单元验证     | 15%          | unit test / typecheck / lint            |
| 集成验证     | 15%          | integration / build / e2e（按项目实际） |
| Final review | 10%          | 检查 diff、清理、总结与最终确认         |

| **重要约束**                                                                                      |
|---------------------------------------------------------------------------------------------------|
| 仅“实现完成”时，默认进度不应超过约 60%。若测试失败、出现新的阻塞或 Agent 重新规划，进度允许回退。 |

## 10. ETA 的设计

ETA 必须展示为区间 + 置信度，而非假装精确。V0 可以使用规则和 milestone 权重；历史数据积累后再升级统计模型。

- V0：根据 elapsed / estimated progress 进行基础外推，并对测试失败、阻塞、长时间无有效进展增加风险系数。

- V1：按任务类型、文件数、tool calls、失败测试数、model、reasoning effort 等保存特征。

- V2：使用历史相似任务或 LightGBM/XGBoost/回归模型预测 remaining duration，并给 P50/P80 或 min-max 区间。

- ETA 必须可以上升：发现架构问题或 integration failure 后，从 8 分钟变成 20 分钟是合理行为，而不是“预测失败”。

## 11. 初步实施路线

| **阶段**               | **主要成果**                                                          | **验收点**                                         |
|------------------------|-----------------------------------------------------------------------|----------------------------------------------------|
| Phase 0 · Spike        | 验证 Claude Code CLI / Codex CLI 能拿到哪些结构化输出、日志和进程信息 | 形成 capability matrix；明确不可依赖的数据         |
| Phase 1 · Core         | Unified Event Schema、Event Bus、Session State、SQLite                | 可写入/查询一条完整 session timeline               |
| Phase 2 · CLI Adapters | ClaudeAdapter + CodexAdapter；agent-scope run ... wrapper             | 能同时监控两个 CLI session                         |
| Phase 3 · Progress     | milestone、Git、test signal 聚合；规则型 progress                     | 进度可解释且验证前不会虚假 100%                    |
| Phase 4 · Dashboard    | React Dashboard + WebSocket 实时刷新                                  | 项目总览、Agent Card、详情 Timeline 可用           |
| Phase 5 · ETA V0       | 区间 ETA + confidence + 变化记录                                      | 测试失败时 ETA 能合理增大，低数据时标低置信度      |
| Phase 6 · Codex App    | External observer / 可用的原生接口适配（以实测为准）                  | 即使无原生事件也可从 repo/environment 展示活动状态 |
| Phase 7 · Multi-Agent  | Planner/Worker session group、project aggregate                       | 支持 4+ session 同时监控并标识 blocked/completed   |

## 12. 推荐的 V0 范围

| **V0 只做两类 Agent**                                                                                                                        |
|----------------------------------------------------------------------------------------------------------------------------------------------|
| Claude Code CLI + Codex CLI。环境先保证本机 Windows/WSL/macOS/Linux 中至少两种可工作。Codex App、远程主机、token cost、智能 ETA 都放到 V1+。 |

- CLI：agent-scope run claude \[args...\]；agent-scope run codex \[args...\]。

- Dashboard：Active sessions、状态、当前 activity、elapsed、progress、ETA、最近 5 条事件。

- 详情：timeline、files changed、last command、test result、milestones。

- Storage：SQLite；本机单用户；不做账号系统。

- Progress：规则型，可解释；支持回退。

- ETA：min-max + confidence，低置信度时可以只显示“~10–25m / Low”。

## 13. 风险与提前规避

| **风险**                       | **应对**                                                                            |
|--------------------------------|-------------------------------------------------------------------------------------|
| 不同 Agent 的事件能力差异大    | Capability-based adapter；核心事件允许缺失，不追求伪统一。                          |
| Codex App 未暴露足够稳定接口   | 优先 external observability；绝不依赖 OCR / UI automation 作为核心方案。            |
| 进度百分比造成“虚假精确”       | 展示阶段解释、confidence；验证阶段保留权重；允许回退。                              |
| ETA 波动大                     | 区间而非单点；记录预测原因；历史数据不足时明确 Low confidence。                     |
| AgentScope 自己影响 Agent 性能 | Collector 异步、事件批量写入；wrapper 不修改原始 stdout 语义。                      |
| 跨 WSL/Windows 路径混乱        | 内部统一 canonical workspace/session id；Adapter 保留 native path 与 display path。 |

## 14. 第一阶段成功标准

1.  在同一台机器上启动一个 Claude Code CLI 和一个 Codex CLI 任务，Dashboard 能同时显示两者。

2.  用户可以在 3 秒以内看见新的关键事件（命令、文件修改、测试状态或阶段变化）。

3.  任务尚未通过约定验证前，不显示 100%。

4.  测试从 pass 变 fail 或出现 blocker 后，状态和 ETA 会反映风险，而不是继续单调增长。

5.  Agent 退出或异常终止后，session 被正确标记 completed / failed / interrupted。

6.  Adapter 层与 Core 解耦：增加一个 MockAdapter 不需要改 Dashboard / Progress Engine 的核心逻辑。

## 15. 后续与多 Agent 编排的关系

AgentScope 可以先独立作为“观测层”存在；当你后续实现 Planner → 多 Worker → 自动回传 → 再派任务时，Planner 可以直接订阅 AgentScope 的 session state，而不是解析各 Agent 的 UI 或自然语言。这样 AgentScope 会自然成为多 Agent 系统的 control plane / observability substrate。

## 16. 当前建议的开发顺序

    1. 先做 capability spike
    2. 定 Unified Event Schema
    3. 做 Event Bus + SQLite + MockAdapter
    4. 接 Claude Code CLI
    5. 接 Codex CLI
    6. 做最小 Dashboard
    7. 加 Progress Engine
    8. 加 ETA V0
    9. 再碰 Codex App
    10. 最后再做 multi-agent orchestrator 集成

| **决策建议**                                                                                                                                       |
|----------------------------------------------------------------------------------------------------------------------------------------------------|
| 不要先花大量时间做漂亮 Dashboard，也不要先训练 ETA 模型。真正的技术护城河首先是：稳定采集不同 Agent 的运行信号，并把它们转换成统一、可解释的状态。 |
