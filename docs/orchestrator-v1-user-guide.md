# AgentScope Orchestrator V1 使用指南

本文面向第一次使用 AgentScope 的用户，说明如何启动服务、监控 Claude/Codex、提交较大的 Goal、
在安全边界介入执行，以及在服务重启后恢复。文中的命令均以 Windows PowerShell 为例；WSL2 的差异在
[WSL2 同库联动](#wsl2-同库联动) 中说明。

## 1. 先理解两个入口

AgentScope 有两个互补入口：

| 入口 | 适合场景 | Dashboard 中看到的内容 |
| --- | --- | --- |
| `claude` / `codex` TTY | 像平常一样进行多轮对话、审批和交互 | Session、Turn、PTY/进程/文件/Git observer evidence、实时进度投影 |
| `orchestrate` 或 Dashboard Goal | 把一个较大的目标拆成多个可验收 Task，自动执行并在边界处介入 | Goal → Task → Attempt → Verification、路线图、指令、审批、预算、恢复、通知 |

TTY 是完整的交互终端体验，但不能读取 Provider 的私有结构化帧；因此 TTY 中的工具调用、Token、原生
milestone 和精确 ETA 可能显示 `Unavailable`。需要 Provider 原生 JSONL 事件时，使用 structured 入口；
需要 Codex 细粒度 JSON-RPC 事件时，使用 app-server 入口。三种入口写入同一个本地 SQLite 数据库，
但不能把一次普通 TTY 会话误当成 Orchestrator Goal。

## 2. 安装与启动

在项目根目录打开 PowerShell：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
pnpm install
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start
```

`pnpm start` 会启动 AgentScope Server（默认 `127.0.0.1:8787`）和 Dashboard（默认
`127.0.0.1:5173`）。浏览器打开 <http://127.0.0.1:5173/>，看到 `Live updates connected` 后再启动
Provider。若 Dashboard 已由另一个终端运行，可使用：

```powershell
pnpm start -- --no-dashboard
```

只允许一个 Server 进程使用同一个数据库路径。遇到 `EADDRINUSE` 时，先找到并停止占用 8787 的旧
Server，再重试；不要为了绕过错误而改用第二个数据库，否则页面会看不到另一终端的任务。

## 3. 配置 Provider 密钥

密钥只应从本机私密配置加载，不能写进仓库、Prompt、命令历史或截图。项目中的 `.env.claude-test.ps1`
和 `.env.glm-test.ps1` 已被 Git 忽略，可按本机实际 Provider 配置使用；如果自行新建配置文件，也要把
文件加入 `.gitignore`。

例如，配置文件加载后只检查变量是否存在，不打印值：

```powershell
. .\.env.glm-test.ps1
if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_BASE_URL) -or
    [string]::IsNullOrWhiteSpace($env:ANTHROPIC_API_KEY) -or
    [string]::IsNullOrWhiteSpace($env:ANTHROPIC_MODEL)) {
  throw 'Provider environment is incomplete.'
}
```

如果 Kimi endpoint 返回并发限制，等待约一分钟后再重试；也可以切换到本机已经配置且获授权的兼容
Provider。AgentScope 不会自动替换 API key，也不会把认证失败当成任务完成。

## 4. 使用 Claude/Codex 的完整 TTY 多轮体验

### 4.1 Claude（Windows）

保持 Server/Dashboard 终端运行，在第二个 PowerShell 中执行：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
. .\.env.glm-test.ps1
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs claude --agent-scope-accept-api-key
```

`--agent-scope-accept-api-key` 表示允许 Claude CLI 使用当前环境变量中的 key；它不是 AgentScope 的
另一把 key。进入 Claude 后，在同一个终端像平常一样输入多轮指令。AgentScope 会在后台创建一个 Session，
并把 Turn 边界、进程状态、PTY 输入观察、工作区/Git 变化和完成状态写入数据库。

### 4.2 Codex（Windows）

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs codex
```

Codex 的登录、模型和审批仍由 Codex CLI 自己管理。正常多轮对话继续在该终端完成；AgentScope 只负责
观察和持久化，不会把 TTY 私有内容改写成不存在的原生 tool/milestone/token 事件。

### 4.3 TTY Dashboard 观察点

在 Dashboard 首页选择最新 Session，重点看：

1. `Active`/`Completed`/`Failed` 状态是否跟随终端生命周期变化；
2. `Turns` 是否按每一轮出现并显示 `running`、`waiting` 或 `completed`；
3. `Observer Evidence` 的来源是否为 `process`、`filesystem`、`git`、`interactive-pty`；
4. `Timeline` 是否按顺序记录 Session/Turn 开始、更新和结束；
5. TTY 不提供的字段是否明确显示 `Unavailable` 或低置信度，而不是伪造精确数值。

页面刷新或 WebSocket 重连后，Dashboard 会先读取 HTTP 快照再继续实时广播，因此不会因为刷新而重复
Timeline。浏览器通知需要先点击 `Enable notifications` 并允许 Edge 权限；拒绝权限不会影响任务监控。

## 5. 使用 structured 与 Codex app-server

### 5.1 Claude structured

structured 入口适合一次性任务、自动化和需要 Provider 原生 JSONL 的场景：

```powershell
node .\apps\cli\bin\agent-scope.mjs run claude -- `
  --print `
  --output-format stream-json `
  --verbose `
  --include-hook-events `
  --include-partial-messages `
  -p '只读检查当前工作区并最后输出 STRUCTURED_OK'
```

只在 Provider 确实支持时展示 token、tool、hook 或 usage；缺失能力会显示 `Unavailable`。不要在普通
TTY 中期待同样的 Provider 原生字段。

### 5.2 Codex structured

```powershell
node .\apps\cli\bin\agent-scope.mjs run codex -- `
  --sandbox read-only `
  --skip-git-repo-check `
  -C (Get-Location).Path `
  '只读检查当前工作区，最后输出 STRUCTURED_CODEX_OK'
```

Codex JSONL 中能可靠识别的 usage、tool、command 和 session 信息会归一化到 AgentScope；未知命令、
cost 或原生 milestone 保持 `Unknown`/`Unavailable`。

### 5.3 Codex app-server

```powershell
node .\apps\cli\bin\agent-scope.mjs run codex-app-server -- `
  --sandbox read-only `
  -C (Get-Location).Path `
  '读取 package.json，最后输出 APP_SERVER_OK'
```

app-server 是一轮 JSON-RPC 任务，不是可附着到官方 Codex Desktop App 的接口。它能提供更细的 item、
tool、file、plan、usage 事件；当前没有完整的 AgentScope 审批 UI，遇到需要审批的动作会保守拒绝并
将 Session 标为 blocked。需要连续人工对话时仍使用 Codex TTY。

## 6. 提交并控制一个 Orchestrator Goal

### 6.1 从 Dashboard 创建

在 `ORCHESTRATOR / Goals and evidence-gated work` 面板填写：

- `Workspace`：真正要操作的项目目录，而不是 AgentScope 仓库（除非目标就是它）；
- `Provider`：Claude、Codex CLI 或 Codex app-server；
- `Goal`：目标、不可修改的约束、验收标准和不应执行的动作。

点击 `Start goal` 后，浏览器只调用 Server API；Provider 由 Orchestrator 在后台启动。单个 Goal 同时只
允许一个 Task 和一个 Worker Attempt，其他 Goal 不会并行抢占工作区。

### 6.2 从 CLI 创建

```powershell
node .\apps\cli\bin\agent-scope.mjs orchestrate `
  --provider claude `
  --workspace 'D:\大学\项目\MyProject' `
  --prompt '实现登录接口，补充测试并运行必要的类型检查；不要推送远程仓库。'
```

CLI 会返回 JSON 摘要：退出码 `0` 表示完成，`3` 表示需要人工处理，其他非零值表示失败。Goal 仍写入
`AGENTSCOPE_DATABASE`，因此 Dashboard 可以同时观察。

### 6.3 理解状态与控制按钮

| 状态/按钮 | 含义与安全边界 |
| --- | --- |
| `CREATED` / `PLANNING` / `RUNNING` / `VERIFYING` | 正在准备、执行或验证；普通指令只排队到下一安全边界 |
| `PAUSED` + `Continue` | 已在边界暂停；Continue 不复用旧 Attempt，也不跳过验证 |
| `NEEDS_HUMAN` + `Continue` | 证据、权限、预算或恢复状态不确定；先处理页面给出的原因再继续 |
| `Retry` | 为合适的失败 Task 创建新 Attempt；历史 Attempt 不改写 |
| `Abort` | 在安全边界终止 Goal，不可撤销；需要明确确认 |
| `COMPLETED` / `FAILED` / `ABORTED` | 终态；完成必须有独立 Verification 证据 |
| `Archive` / `Restore` | 只对非活动 Goal 可用；归档隐藏历史但不删除 Task、Attempt、Verification 或事件 |

### 6.4 Give Instruction、路线图和审批

- `Give Instruction` 用于补充约束、优先级、澄清或批准上下文。运行中的指令显示 `PENDING`，只在安全
  边界应用；不能直接注入已经启动的 Provider 进程。
- 编辑未来 Task、插入、跳过和重排会产生新的 immutable roadmap revision；已经运行或完成的 Task 不显示
  危险编辑按钮。`Skip` 是可审计的 `SKIPPED`，不是物理删除。
- 高风险动作必须有精确的 action/scope/revision Approval。未批准不会启动该动作；审批不是永久通配权限。
- 页面中的 `Verification`、`Evidence` 和 `Explanation` 优先于 Worker 自报的“完成”。

## 7. Goal 历史、归档与 Session 清理

Goal 历史支持状态、Provider、Workspace、文本搜索和稳定 cursor 分页。默认页面隐藏已归档 Goal；勾选
`Include archived` 后可以查看并在详情中 `Restore`。归档只改变可见性，不删除数据，且会留下
`goal.archived` / `goal.unarchived` 审计事件。

Session 的 `Hide`/`Delete` 与 Goal 归档是两套语义：

- `Hide` 是可恢复的软隐藏，保留 Session、Turn、Evidence 和 ETA；
- `Delete` 是不可逆的级联删除，只对已结束 Session 提供；运行中的 Session 不显示删除按钮并由后端拒绝；
- 删除 Session 不会自动删除相关 Goal 历史，Goal 需要单独归档。

## 8. 重启、恢复与故障排查

1. 先停止旧 Server，确保没有第二个进程继续写同一个数据库。
2. 重新执行第 2 节的 `pnpm start`，打开 `/healthz` 确认 `status: ok`。
3. 如果之前在 Worker 运行时崩溃，执行：

   ```powershell
   node .\apps\cli\bin\agent-scope.mjs recover
   ```

4. 在 Dashboard 检查 Goal/Session 是否进入 `NEEDS_HUMAN` 或 `interrupted`，确认外部 Provider 进程已经停止，
   再使用 `Continue`/`Resume`。AgentScope 不会在无法证明旧进程已停止时盲目启动第二个 Attempt。

常见问题：

- 页面 404 或空数据：确认 Server、Dashboard 和 Provider 使用同一个绝对数据库路径；
- `ECONNREFUSED 127.0.0.1:8787`：Server 没有监听，或 Vite 代理指向了错误端口；
- `EADDRINUSE`：仍有旧 Server 占用端口；停止它后再启动；
- `Not logged in`：这是 Provider CLI 的认证状态，不是 AgentScope 认证；重新在当前终端加载私密环境并使用
  `--agent-scope-accept-api-key`（Claude）或按 Codex 自己的登录流程处理；
- Provider 并发限制：等待 endpoint 释放后重试，不要并行发送同一账户的多个真实任务。

## 9. WSL2 同库联动

WSL2 终端需要 Linux Node/pnpm 和用户自己的环境配置。不要在 Windows checkout 中复用 Linux
`node_modules`；最稳妥的方式是在 WSL2 checkout 安装依赖，Windows Server/Dashboard 与 WSL2 Provider
指向同一个可访问的 SQLite 文件（或让 WSL2 Server 与 WSL2 Dashboard 都使用同一文件）。

在 WSL2 中使用交互式 shell 加载用户配置后：

```bash
cd /path/to/AgentScope
source ~/.bashrc
export AGENTSCOPE_DATABASE=/path/to/shared/.agentscope/agentscope.db
node ./apps/cli/bin/agent-scope.mjs claude --agent-scope-accept-api-key
```

Windows 与 WSL2 的路径必须是各自环境可访问的同一文件，不能只把 `D:\...` 原样复制到 Linux shell。
Dashboard 通过数据库轮询和 WebSocket 广播接收跨进程变化；重连后以 HTTP 快照补齐，不依赖两个进程共享
内存。WSL2 的完整真实 Provider TTY 仍取决于终端、挂载权限和网络，发布矩阵会如实标记未执行的平台。

## 10. 数据与安全边界

- 默认只保存归一化事件和 observer evidence，不保存完整 Provider 原始输出；
- 项目路径、Git 分支、事件 payload 和数据库备份仍可能包含本地开发信息，应按本地开发数据保护；
- 不把 API key 放进 Goal、Instruction、日志、截图或 Git；
- Verifier 只执行结构化的 `executable + args`，不拼接 shell 字符串；
- AgentScope V1 不自动 push、deploy、merge、跨机器执行或并行 Worker。

更完整的迁移、备份和恢复流程见 [V1 运维与迁移指南](orchestrator-v1-operations.md)，能力边界见
[V1 发布说明](v1-release-notes.md) 与 [Known Issues](known-issues.md)。
