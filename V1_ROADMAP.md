# AgentScope V1 / 交互式 TTY 路线图

- 状态：规划基线
- 主要目标环境：Windows 11 + VS Code PowerShell + Claude Code harness + 兼容 Kimi API
- 第二目标环境：WSL2 Ubuntu
- 起点：V0 的本地优先、结构化/非交互式监控已经完成，并继续作为兼容性回退路径。

## 1. V1 总目标

V1 要把 AgentScope 从“单个结构化 prompt 的 wrapper”升级为“日常 Claude Code 使用的伴随式监控器”。目标体验是：

```text
终端 A：agent-scope start
终端 B：agent-scope claude

用户提交第 1 轮任务 ─┐
Claude 执行           ├─ Dashboard 实时更新
用户提交第 2 轮任务 ─┤
Claude 执行           └─ 每一轮保留独立状态和证据
```

Claude 终端必须仍然像原生 Claude Code 一样使用：颜色、光标、多行输入、审批界面、slash 命令、窗口缩放和中断都不能被 AgentScope 破坏。AgentScope 负责观察和投影 session，不替换 Claude Code 的对话界面。

## 2. 已确定的产品决策

- [x] 以路线一作为可靠底座：透明 PTY/ConPTY，加上进程、文件系统、Git 和验证 observer。
- [x] 以路线二作为增强通道：在可用时接入稳定的 Claude hooks 或旁路事件，并具备能力检测和优雅回退。
- [x] 不实现路线三：AgentScope 不开发一个围绕重复非交互式 provider 调用的替代聊天界面。
- [x] 保持 Claude Code 使用兼容 Kimi endpoint 的方式。AgentScope 包装本地 Claude harness，不要求 Anthropic 账号，也不直接调用 Anthropic API。
- [x] 优先提升实际使用体验。用户提交的任务文本可以在本地保存，用于任务标题和历史记录；明显凭据仍然自动脱敏，隐藏推理和 provider 内部数据不保存。
- [x] 保留 V0 结构化路径，用于自动化、CI 和不需要交互式终端的任务。

## 3. V1 范围和优先级

### P0 — 第一版可用 V1 必须包含

- Windows ConPTY 和 WSL2/Linux PTY 透明运行时。
- 新的交互式 CLI 入口，暂定为 `agent-scope claude`。
- 一个终端 session 中包含多轮任务。
- 每轮任务独立的生命周期、持续时间、当前活动、Progress、ETA 和 evidence。
- 正确的输入/输出转发、窗口缩放、Ctrl+C、正常退出和崩溃恢复。
- 将进程、文件、Git 和已知验证信号关联到当前 turn。
- Dashboard 展示 session/turn 层级和实时更新。
- 当前 Kimi-backed Claude Code 配置能够原样透传。

### P1 — TTY 稳定后增加的体验增强

- Claude `--resume`/`--continue` 关联。
- 可靠显示等待用户和 blocked 状态。
- 每轮文件变化、测试结果和 Git commit 关联。
- 多个 Claude/Codex session 并行分组。
- 长任务完成通知和阻塞通知。
- Timeline 搜索、筛选和 turn 导航。

### P2 — 依赖证据质量的可选增强

- CPU、内存、进程树和长时间运行容量指标。
- 只有 provider 提供稳定可信数据时才展示 token/cost。
- 本地 turn 摘要和可搜索历史。
- 任务耗时、验证成功率等趋势视图。

### 第一版 V1 明确不做

- 替换原生 Claude Code 终端或审批界面。
- 可靠 attach 到一个不是由 AgentScope 启动的任意 `claude` 进程。
- 远程执行、账号、多设备同步或 hosted control plane。
- 持久化隐藏推理、chain-of-thought、凭据或 provider 内部数据。
- 把未公开的 Claude 内部文件作为唯一事实来源。

## 4. 目标架构

```text
VS Code 终端
    │ 键盘、窗口缩放、Ctrl+C
    ▼
AgentScope interactive CLI
    │
    ├── PTY runtime ───────────────► Claude Code 原生 TUI
    │       │ 终端生命周期
    │       └──────────────────────► 进程 evidence
    │
    ├── turn coordinator ◄───────── 用户输入边界
    │       │
    │       ├── 文件系统/Git/测试 observer
    │       └── 可选 Claude hooks 旁路
    │
    ▼
SQLite：terminal session + turn + 归一化 event + evidence
    │
    ▼
AgentScope server ── HTTP cursor 恢复 + WebSocket ──► Dashboard
```

PTY 路径负责终端保真度；observer 和可选 hooks 负责语义化进度。hooks 失效时只能降低信息丰富度，不能终止 Claude 或交互式终端。

## 5. 数据模型方向

V0 的 session 仍然是顶层执行记录。V1 增加 turn 层：

```text
AgentSession
├── 终端元数据和 provider session id
├── Turn 1
│   ├── 提交文本/标题
│   ├── 生命周期和当前活动
│   ├── event 和 evidence
│   └── verification/Progress/ETA snapshot
├── Turn 2
└── Turn N
```

计划增加的存储内容：

- `turns`：id、session id、顺序、标题/文本、状态、开始/结束时间和来源。
- `turn_events`，或在归一化 event 上增加可空 `turn_id`；先通过 ADR 和迁移实验决定具体方案。
- turn 范围内的 observer evidence 和 verification snapshot。
- 将 provider resume identity 与 AgentScope session id 分开保存。
- 终端能力元数据：平台、PTY 驱动、交互/hooks 能力和回退模式。

迁移必须保留所有 V0 数据库。没有 turn 的历史 session 仍然可读，并以 legacy 单任务 session 展示。

## 6. 实施计划

### Phase 0 — 冻结交互契约并选择 PTY 驱动

#### Step 0.1 — 定义终端行为契约

- [x] 记录颜色、光标控制、多行输入、粘贴、审批界面、slash 命令、窗口缩放、Ctrl+C、Ctrl+Break、EOF 和正常退出的预期行为。
- [x] 区分“中断当前 Claude 动作”和“终止整个交互式 session”。
- [x] 定义支持的启动方式和参数透传边界。
- [x] 增加 ADR，说明为什么由 AgentScope 拥有子进程 PTY，而不是 attach 到任意已运行进程。

验证：使用 fake interactive CLI，在不调用真实 provider 的情况下覆盖契约；明确覆盖 Windows PowerShell、VS Code Terminal 和 WSL2。契约已记录在 `docs/decisions/0007-interactive-pty.md`。

提交边界：只提交终端契约、ADR 和 fake fixture。

#### Step 0.2 — 比较 PTY/ConPTY 驱动选项

- [x] 评估支持 Windows ConPTY 和 Unix PTY 的维护中 Node 驱动；`node-pty` 已作为首选候选。
- [x] 比较原生构建要求、Node 22/24 兼容性、Windows ARM/x64、缩放/信号、Unicode、版本健康度和供应链风险。
- [x] 在 Windows 用 fake TUI 做一次隔离 PoC。
- [x] 选择 `node-pty` 作为 V1 驱动，记录拒绝的方案和 V0 结构化回退行为。

验证：Windows 与 WSL2/Linux 的 spawn、输入、输出、缩放和 Ctrl+C 隔离 smoke 已通过；重复 cleanup、Unicode、长输出/backpressure 和 runtime clean-install 门禁仍待完成。当前结果见 `docs/findings/pty-driver.md`，正式接入生产路径前必须完成剩余门禁。

提交边界：驱动决策和隔离 spike，暂不接入生产路径。

#### Step 0.3 — 检查 Claude 交互和 hooks 能力

- [x] 为当前安装的 Claude Code 版本生成脱敏 capability matrix。
- [ ] 验证在兼容 Kimi endpoint 下，交互 turn、tool call、notification 和 stop 期间哪些文档化 hooks 会触发。
- [ ] 验证 `--resume` 和 `--continue` 的 identity 及失败行为。
- [x] 确认基础 PTY 运行不依赖 hooks。

验证：已记录 `docs/findings/claude-capabilities.md`；fixture 只包含形状，不包含 prompt、API key 或原始推理；
hooks 缺失或变化时进入明确的低能力模式。真实 provider hook/续接行为留到 Phase 3 disposable project 验收。

提交边界：capability findings、脱敏 fixture 和 parser 测试。

### Phase 1 — 协议和存储基础

#### Step 1.1 — 增加 turn 协议 ✅

- [x] 定义 `TurnStatus`、`TurnState`、`TurnStarted`、`TurnUpdated` 和 `TurnFinished` schema。
- [x] 定义 turn 范围内的 activity、verification、Progress 和 ETA projection。
- [x] 以兼容方式扩展协议，让 V0 consumer 可以忽略 V1 notification。
- [x] 增加 malformed、未知字段和 replay 顺序测试。

验证：schema、parser 和兼容性测试通过，且不改变 V0 event 含义。

提交边界：协议类型和测试。

#### Step 1.2 — 增加向后兼容的存储迁移 ✅

- [x] 增加 turn 表和 session/顺序/时间查询所需索引。
- [x] 通过 ADR 决定 event 直接引用 turn，还是使用映射表。
- [x] 增加 turn 的创建、开始、更新、结束和列表 repository。
- [x] 增加迁移、回滚/备份说明和 V0 数据库兼容测试。
- [x] 保持 transaction-before-broadcast 顺序。

验证：复制出的 V0 fixture 数据库可以迁移并正常读取；并发写入和 busy-error 归一化仍然正确。

提交边界：migration、repository 和 storage 测试。

#### Step 1.3 — 实现 turn reducer ✅

- [x] 为 queued/running/waiting/blocked/completed/failed/interrupted 实现确定性的状态转换。
- [x] 不让单个可恢复的工具错误自动覆盖后续成功的 turn 结果；失败工具仍保留为 evidence。
- [x] 区分 terminal session 失败和单个 turn 失败。
- [x] 增加 replay、重复、乱序和崩溃恢复测试。

验证：从已存 event 重放时，session 和 turn 状态保持可重复。

提交边界：reducer 和 projection 测试。

### Phase 2 — 跨平台 PTY runtime

#### Step 2.1 — 创建 provider-neutral terminal package

- [x] 提供 spawn、write、resize、interrupt、terminate 和 async output API。
- [x] 归一化终端生命周期，但不改写 ANSI 输出。
- [x] 限制输出 buffer，在不阻塞子进程的情况下处理 backpressure。
- [x] 默认只在内存中保留原始终端 chunk。

验证：基础生命周期、重复 cleanup、有界输出、碎片化多字节 chunk 和慢读取方的单元测试已通过；
Windows native PTY smoke 已覆盖 ANSI/Unicode 输出、resize、正常退出和重复 cleanup；多小时
backpressure 和 clean-install CI 仍待补齐。

提交边界：独立 terminal package 和测试。

#### Step 2.2 — 实现 Windows ConPTY 行为

- [ ] 保持 VS Code PowerShell 的输入、Unicode、粘贴和窗口缩放。
- [ ] 在 Claude 允许的范围内区分 Ctrl+C 当前动作和整个 session 终止。
- [ ] wrapper 退出时清理自己拥有的进程树，不误杀无关进程。
- [ ] 终端突然关闭后恢复 stale session。

验证：自动 fake-process 测试，加一次真实 Windows 手工 smoke。

提交边界：Windows runtime 和平台测试。

#### Step 2.3 — 实现 WSL2/Linux PTY 行为

- [ ] 使用 Unix PTY 语义提供同一套 provider-neutral contract。
- [ ] 独立验证 Linux 路径、信号、缩放和 UTF-8，不能把 Windows `node_modules` 带入 Linux。
- [ ] 保持 WSL2 server、CLI 和数据库使用 Linux checkout 的原生路径。

验证：fake TUI 和 Mock interactive session 在隔离 WSL2 checkout 中通过。

提交边界：Unix runtime 和 WSL2 smoke 文档。

### Phase 3 — 交互式 Claude wrapper MVP

#### Step 3.1 — 增加 interactive CLI 命令

- [x] 增加 `agent-scope claude`，透明透传参数和环境。
- [x] 从调用方当前目录解析 workspace。
- [x] 使用运行中 Dashboard 的同一个数据库。
- [x] PTY 驱动或 Claude executable 不可用时返回可诊断错误。
- [x] 保持 `agent-scope run claude -- -p ...` 不变。

验证：fake PTY 集成测试、Windows `claude --version` smoke 和 Windows VS Code PowerShell
中的 GLM 真实多轮交互已通过；环境透传、Dashboard 同库联动和第一次 Ctrl+C 中断当前动作
已确认；终端 resize 人工验收也已通过。
普通模式下的显式 API key 确认辅助已实现：仅在检测到明确的 provider API key 提示时向 PTY
写入一次 yes，不启用 --bare，也不改变其他交互输入。
针对自定义 endpoint 的普通模式认证差异，交互式子进程会在 AUTH_TOKEN 未显式设置时从
ANTHROPIC_API_KEY 补齐；GLM 真实普通模式已通过，不再出现 Not logged in。
Windows 现代终端使用 Console VT 键盘记录时，AgentScope 会仅为本地 turn 边界识别还原
按键文本；转发给 Claude 的原始键盘字节保持不变，避免改变原生交互行为。
对于终端 host 未被增量解码器识别的 bracketed paste，额外按边界标记恢复待分类文本；恢复内容
只用于本地 turn 识别，不改变转发给 Claude 的原始字节，也不自动持久化完整输入。

提交边界：CLI 入口和 fake-provider 集成。

#### Step 3.2 — 保持原生交互体验

- [ ] 转发键盘和输出，不在 Claude UI 中插入 AgentScope 自己的提示。
- [ ] 转发窗口缩放，并在正常/异常退出后恢复本地终端状态。
- [ ] 保留 exit code，并分别识别 wrapper/provider/terminal failure。
- [ ] AgentScope diagnostics 输出到独立且安全的通道或日志。

验证：ANSI snapshot/fake TUI 测试和终端恢复测试。

提交边界：交互式 stream 和生命周期行为。

#### 第一个用户验收点

Step 3.1–3.2 自动化通过后，进行一次 Windows VS Code Terminal 手工 smoke：

1. 启动 AgentScope 和 Dashboard。
2. 在可信的 disposable project 中运行 `agent-scope claude`。
3. 使用普通 Claude 输入、多行粘贴、一次审批和一次 Ctrl+C。
4. 确认原生界面仍然可用，且没有 orphan process。

如果 wrapper 破坏了日常 Claude 使用体验，不进入 turn 语义识别阶段。

### Phase 4 — 多轮任务识别

#### Step 4.1 — 实现 turn coordinator

- 基础 coordinator 已实现：提供显式 submitTask/observe/markWaiting/markBlocked/resume/finish 边界，
  并以确定性测试保护任务输入分类和单调 turn identity。普通交互模式的 PTY 输入已经接线，
  `--agent-scope-accept-api-key` 路径会记录多轮任务；`--bare` 保持保守兼容路径。
- 双通道 signal arbiter 已实现：hook/manual 信号优先，PTY fallback 必须达到置信度门槛，
  低置信度信号只返回诊断结果，不改变 turn 状态。
- hook event mapper 和 PTY detector 已实现并测试：结构化 turn 生命周期为高置信度；普通模式
  在观察到实际活动后，回到 Claude 输入提示会产生高置信度完成候选；显式 AgentScope marker
  仍可产生高置信度 PTY signal；审批/授权提示保持 waiting，不会被完成提示覆盖。
- 交互式 CLI 现将 `turn_started`、`turn_updated`、`turn_finished` 写入 session timeline，并保存
  不含完整 prompt 的本地 task-boundary evidence；Dashboard 的 Activity 和 Evidence 因而至少可
  显示任务提交/完成。进程、文件系统和 Git evidence 的 turn 归属仍在 Phase 5。
- [x] 识别终端何时等待用户输入、何时提交任务开始工作、何时 Claude 回到 idle/waiting。
- [ ] 有稳定 hook 信号时，将输入边界与 hook 信号合并。
- [x] 不把审批按键、slash 命令导航或多行编辑误判成新任务。
- [x] 分配单调递增的 turn 序号和稳定 id。

验证：fake terminal transcript 覆盖单行、多行、审批、取消、重试和快速连续 turn。

提交边界：coordinator 和确定性测试。

#### Step 4.2 — 捕获有用的本地任务身份

- 基础 prompt/title 策略已实现：标题从脱敏后的首行生成，常见 token/key/password 形状会在进入 turn projection 前替换为
  [REDACTED]；可通过 persistPrompt: false 只保留标题。普通 CLI/PTY 路径已接入该策略。
- [x] 在本地保存提交的任务文本，并生成 Dashboard 紧凑标题。
- [ ] 脱敏明显的 secret 格式，环境变量内容不能进入标题。
- [ ] 提供“只保存标题”或“关闭 prompt 持久化”的配置开关。
- [x] 默认不持久化隐藏推理或完整终端 transcript。

验证：凭据样例被脱敏；Unicode 和多行 prompt 能正确往返。

提交边界：本地 prompt/title 策略和测试。

#### Step 4.3 — 分类 waiting、blocked 和终态

- [ ] 区分 Claude 工作中、工具运行中、等待审批、等待用户、blocked、completed、failed 和 interrupted。
- [ ] 把单个工具错误作为 evidence；turn 结果根据 provider、verification 和 recovery 信号判断，而不是只看一个错误位。
- [ ] 定义超时/stale 行为，不能伪造完成状态。

验证：失败工具后恢复、最终回答成功等状态机 fixture 通过。

提交边界：turn 生命周期语义和回归测试。

### Phase 5 — 按 turn 关联 observer

#### Step 5.1 — 将现有 observer 绑定到活动 turn

- [x] 将 turn lifecycle/task-boundary evidence 绑定到活动 turn，同时保留 session 级来源信息；兼容旧数据中把 `turnId` 放在 payload 的记录。
- [x] 将交互式 filesystem evidence 按 turn 时间窗口绑定到活动 turn，覆盖 debounce/异步回调，并将 `fileEvents` capability 标为可用。
- [x] Dashboard 在旧 server 进程暂未暴露 `turnId` 时，按 turn 时间窗口兼容归属 observer evidence，避免已写入的文件证据在展开详情中消失。
- [x] 将进程和 Git evidence 绑定到活动 turn，同时保留 session 级来源信息；session 启动/退出生命周期仍保留为 session 级 evidence。
- [x] 在 turn 开始/结束时 snapshot workspace 与 wrapper 进程，只记录路径、统计和进程状态，不读取无关文件。
- [ ] 防止延迟 debounce event 泄漏到下一个 turn。
- [ ] 通过 fusion ledger 对 native、hook 和 observer evidence 去重。

验证：turn lifecycle、filesystem evidence、process/Git turn snapshot 的 runner 回归测试已通过；两个快速 turn 的 process/Git evidence 均按显式 turnId 分隔；Dashboard 兼容旧 API 响应的时间窗口归属测试已通过。

提交边界：turn-aware observer runtime。

#### Step 5.2 — 关联 verification 和 Git 结果

- [ ] 识别已知的 test、build、typecheck 和 lint 命令。
- [ ] 将 start/result/exit code 关联到正确 turn。
- [ ] 使用 hash、subject 和 changed-file summary 关联 turn 中创建的 commit。
- [ ] 保持 provider `completed` 与客观 verification 状态的区别。

验证：成功、测试失败、重试后通过和 commit 场景均可确定性复现。

提交边界：verification/Git 关联和测试。

### Phase 6 — 可选的 Claude hooks 增强

#### Step 6.1 — 构建能力门控的 hook adapter

- [ ] 只消费文档化或实验确认稳定的 hook 字段。
- [ ] 关联 provider session、turn、tool start/finish、approval 和 stop 信号。
- [ ] 持久化前校验、脱敏和归一化 hook record。
- [ ] 已安装 Claude 版本不兼容时自动关闭 hook 路径。

验证：启用 hooks 和仅 observer 两种模式产生兼容的 turn projection。

提交边界：hook adapter 和脱敏 fixture。

#### Step 6.2 — 明确 Kimi/harness 兼容性

- [ ] 使用当前兼容 endpoint 和 model 重复 hook/TTY 测试。
- [ ] 记录与官方账号示例不同的字段或行为。
- [ ] provider 限流/错误不能破坏终端 session 或数据库。

验证：限流重试、工具失败和正常多轮 session 都可恢复。

提交边界：兼容性测试和 findings。

### Phase 7 — server、实时更新和恢复

#### Step 7.1 — 增加 turn API 和 WebSocket notification

- session turns 列表和单 turn 查询 API 已提供；repository 的 turn.created/turn.updated
  notification 已通过 WebSocket live hub 广播，并增加了对外部 SQLite writer 的 turn created/updated
 轮询和去重测试。按 turn 的 evidence endpoint（limit 查询）和 Dashboard evidence 数量/展开详情已提供；
 游标分页和更完整的 turn event 查询仍待后续完善。
- [ ] 增加 session-turn 和 turn-event/evidence 的分页 endpoint。
- [ ] 发布 `turn.created`、`turn.updated` 和 `turn.finished` notification。
- [ ] Dashboard 断线/重连后保留 HTTP cursor catch-up。
- [ ] 轮询外部 interactive CLI writer，避免重复广播。

验证：跨进程 server/CLI 测试覆盖两个 turn，并在两轮之间断线重连。

提交边界：server API、live protocol 和测试。

#### Step 7.2 — 恢复中断的交互式 session

- [ ] 扩展 `agent-scope recover`，区分 stale terminal session 和 stale active turn。
- [ ] 只标记真正 stale 的记录，不能中断另一个进程拥有的 live PTY。
- [ ] 记录 recovery reason，保留最后一份安全 evidence。
- [ ] server 重启与 interactive CLI 生命周期相互独立。

验证：wrapper 突然终止、Dashboard 重启和模拟机器重启后都收敛到一致状态。

提交边界：恢复行为和故障注入测试。

### Phase 8 — 多轮 Dashboard 体验

#### Step 8.1 — 增加 session 和 turn 导航

- Dashboard session detail 已接入 turns API：显示有序 turn 列表、标题、状态和持续时间，并响应
  turn.created/turn.updated 实时通知自动刷新；turn 条目现在可展开查看已归属的 evidence 摘要，
  更完整的 Progress/ETA/文件/命令/验证详情仍待后续完成。
- [ ] 一个 interactive Claude session 下显示有序 turn 列表。
- [ ] 高亮 active turn，展示标题、状态、持续时间和当前活动。
- [ ] 保持 legacy V0 单任务 session 的展示兼容。
- [ ] hooks 或 verification 不可用时显示清晰的能力标签。

验证：legacy、interactive 和混合 session 列表的数据流/组件测试通过。

提交边界：session/turn UI 骨架。

#### Step 8.2 — 增加每轮 Progress 和 evidence 视图

- [x] 在 Dashboard turn 列表显示每轮 evidence 数量，并可展开查看来源、类型、原因、时间和置信度。
- [x] 将 turn projection 的 Progress、ETA、Activity 和 verification 状态写入存储并在展开详情中展示；完成 turn 在没有验证证据时仍遵守 60% 安全上限。
- [x] 在展开详情中展示包含 `turnId` 的 lifecycle timeline，旧数据也能从 event payload 兼容识别。
- [x] 对已知 observer payload 渲染紧凑摘要（文件路径、命令/退出码、测试结果、Git 变更计数），不展示完整 raw payload，并对凭据形状做前端脱敏。
- [x] 兼容长时间运行的旧 server 响应：显式 `turnId` 缺失时按 turn 开始/结束时间关联证据，并用回归测试防止冲突 ID 被误归属。
- [ ] 对选中 turn 展示 Progress、ETA、文件、命令、测试、Git evidence 和 timeline。
- [ ] 解释 confidence 和 reasons，避免伪精确。
- [ ] 突出等待用户和需要审批的状态。
- [ ] 重连或分页后不重复 event。

验证：两个实时 turn 更新时不丢失选中项，也不重复 timeline。

提交边界：turn detail view 和 UI 测试。

#### Step 8.3 — 增加搜索、筛选和通知

- [ ] 按本地 turn 标题、workspace、状态、文件和 Git commit 搜索。
- [ ] 筛选 active、waiting、blocked、failed 和 completed turn。
- [ ] 对长任务完成和 blocked/approval 状态增加可选桌面通知。
- [ ] 重连/replay 后避免重复通知。

验证：通知幂等性和索引查询测试通过。

提交边界：发现和通知体验。

### Phase 9 — resume、continue 和 session 分组

#### Step 9.1 — 关联 Claude resume identity

- [ ] 将 provider session id 与 AgentScope execution id 分开保存。
- [ ] 在可靠时将 `--resume`/`--continue` 关联到原有逻辑 conversation。
- [ ] 创建新的 execution record，同时保留一个 conversation group。
- [ ] provider id 缺失、变化或不明确时采取保守策略。

验证：resume 成功、无效 id 和并发 resume 不会合并无关任务。

提交边界：conversation grouping 和 resume 测试。

#### Step 9.2 — 支持多个并行 agent

- [ ] 按 workspace 和可选用户项目分组 Claude/Codex session。
- [ ] 并发写入时每个终端和 turn timeline 保持隔离。
- [ ] 增加紧凑的 overview counts 和 blocked/attention 指标。

验证：至少四个并发 interactive/mock session 仍然正确分离。

提交边界：分组和并发 UI/API 测试。

### Phase 10 — 性能和可靠性加固

#### Step 10.1 — 终端和 event 路径性能

- [ ] 测量 PTY 输入/输出延迟、CPU、RSS 和 buffer 增长。
- [ ] 测量 interactive turn 的 event-to-WebSocket 和 event-to-browser-paint 延迟。
- [ ] 压测 ANSI 输出、大量工具输出、窗口缩放风暴和慢 Dashboard client。
- [ ] 根据证据设定限制和 diagnostics，不能让 queue 静默无界增长。

验证：发布 P50/P95 测量结果和各平台支持的容量边界。

提交边界：benchmark 脚本、diagnostics 和 findings。

#### Step 10.2 — 长时间和故障测试

- [ ] 运行多小时 fake 和真实 provider session，包含多轮 turn。
- [ ] 注入 PTY child crash、hook failure、database busy、server restart、WebSocket disconnect 和外层终端关闭。
- [ ] 验证无 orphan process、丢失的 completed turn 或重复 timeline event。
- [ ] 验证数据库备份/恢复和从真实 V0 副本迁移。

验证：自动故障矩阵和有界的手工 provider smoke 通过。

提交边界：故障测试和 known-issues 更新。

#### Step 10.3 — 安全和本地数据控制

- [ ] 在加入原生驱动和 prompt 持久化后重新执行依赖、路径边界、secret 和 shell-injection 审计。
- [ ] 增加 prompt 保留控制和本地删除/导出功能。
- [ ] 原始 transcript 持久化继续保持关闭，除非后续设计了明确 opt-in 功能。
- [ ] 说明 PTY wrapper、hooks 和 observer 能看到哪些数据。

验证：secret fixture 仍然脱敏；删除 turn 的本地 prompt 数据不会破坏 session timeline。

提交边界：数据控制、隐私文档和审计证据。

### Phase 11 — V1 发布验收

#### Step 11.1 — 自动化发布门禁

- [ ] lint、typecheck、unit、integration、migration、fixture 和 build 检查通过。
- [ ] V0 结构化 Claude/Codex workflow 继续通过。
- [ ] Windows ConPTY 和 WSL2 PTY fake/integration suite 通过。
- [ ] 跨进程 turn broadcast、分页和重启恢复通过。

#### Step 11.2 — 手工体验验收

- [ ] Windows VS Code PowerShell：一个 session 中完成至少五轮普通 Claude 任务。
- [ ] 多行 prompt、审批、文件修改、失败后恢复的命令和测试运行。
- [ ] 中断当前动作、正常退出 session 和突然关闭终端。
- [ ] 在 WSL2 重复受支持的交互流程。
- [ ] Dashboard 正确分离 turns，并能经受刷新/重连。
- [ ] resume/continue 行为与文档声明的支持级别一致。

#### Step 11.3 — 发布文档

- [ ] 更新 README、配置、troubleshooting、adapter guide 和 known issues。
- [ ] 发布 V1 acceptance matrix，为每个支持声明提供证据。
- [ ] 将未覆盖的终端主机/provider 版本记录为 experimental。
- [ ] 创建最终本地 release-prep commit；只有得到用户明确确认后才 push/tag。

## 7. 交付顺序和依赖关系

```text
Phase 0 驱动/hooks spike
    ↓
Phase 1 turn 协议/存储
    ↓
Phase 2 PTY runtime
    ↓
Phase 3 可用的交互式 wrapper ── 第一个用户体验验收点
    ↓
Phase 4 turn 识别
    ↓
Phase 5 observer 关联
    ↓
Phase 6 可选 hooks 增强
    ↓
Phase 7 server/恢复
    ↓
Phase 8 Dashboard
    ↓
Phase 9 resume/分组
    ↓
Phase 10 加固
    ↓
Phase 11 V1 验收
```

第一个可用里程碑是 Phase 3：通过 AgentScope 使用 Claude 时，原生交互体验保持良好。第一个产品完整里程碑是 Phase 8：Dashboard 能理解并展示独立 turn。只有这两个里程碑稳定后，才进入 resume/分组和高级指标。

## 8. 每个 Step 的完成定义

每个完成的 step 都必须包含：

1. 一个连贯的实现或文档本地提交。
2. 定向测试，以及与风险相称的 typecheck/lint/integration 验证。
3. tracked fixture 中不包含 secret、完整 prompt 或 raw provider internals。
4. 向后兼容，或者明确的迁移说明。
5. 不只验证 happy path，也验证失败和 cleanup 行为。
6. 同步更新本路线图及相关 findings/known-issues 文档。

## 9. 预计需要用户参与的节点

只有真实终端体验或 provider 行为无法可靠自动化时，才请求用户操作：

1. Phase 3 之后：确认 Windows 原生 Claude 交互、审批、缩放和 Ctrl+C 的体验。
2. Phase 4/6 之后：确认 turn 边界、waiting/blocked 标签是否符合真实使用。
3. Phase 8 之后：在真实多轮编码任务中确认 Dashboard 是否好用。
4. Phase 11：最终 Windows 和 WSL2 发布验收。

其他实现、fixture、自动化测试、迁移、diagnostics 和本地提交，都可以不要求用户逐步审批；只有依赖安装或外部凭据操作需要用户介入时才暂停。
