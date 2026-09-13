# AgentScope Orchestrator 使用说明

本文档对应 `codex/orchestrator-v1` 分支当前实现。Orchestrator 是在现有 Monitor 之上的串行自动执行层：用户提交一个较大的 Goal，系统创建路线图，逐个执行 Task，采集证据，独立验证，必要时有限重试，直到完成或进入人工介入状态。

第一次使用或需要完整 V1 操作流程时，请先阅读[《AgentScope Orchestrator V1 使用指南》](orchestrator-v1-user-guide.md)。本文保留为命令速查和兼容说明。

## 1. 启动本地服务

在项目根目录打开 PowerShell：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start
```

默认会启动 AgentScope Server 和 Dashboard。浏览器打开 `http://127.0.0.1:5173/`。若只需要后端，可使用 `pnpm start -- --no-dashboard`；Server 默认监听 `127.0.0.1:8787`。

## 2. 从 Dashboard 提交 Goal

在 **ORCHESTRATOR / Goals and evidence-gated work** 面板填写：

1. `Workspace`：要被 Worker 操作的项目目录。
2. `Provider`：`Claude`、`Codex CLI` 或 `Codex app-server`。
3. `Goal`：完整描述目标、约束和可验收结果。

点击 **Start goal** 后，前端只调用 HTTP API，不会自行启动进程。Goal 会在页面中显示，WebSocket 会实时刷新 Goal、Task、Attempt、Verification 和 Event。点击 Goal 可查看：

- 所有 Task 的顺序、状态和尝试次数；
- 每个 Task 的最新 Verification 结论；
- Goal Event 时间线、时间戳和置信度；
- Pause、Continue、Abort 控制。

同一时间只允许一个活动 Goal。已在运行的 Goal 存在时，新 Goal 会被安全阻止或进入 `NEEDS_HUMAN`，不会并行启动第二个 Worker。

## 3. 从 CLI 提交 Goal

非交互式 Goal 使用 `orchestrate` 命令。示例：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs orchestrate `
  --provider claude `
  --workspace 'D:\大学\项目\MyProject' `
  --prompt '实现用户登录接口，补充测试，并运行必要的类型检查。不要推送远程仓库。'
```

也可以把 Prompt 放在 `--` 后面：

```powershell
node .\apps\cli\bin\agent-scope.mjs orchestrate `
  --provider codex `
  --workspace 'D:\大学\项目\MyProject' `
  -- '检查当前项目的测试失败原因，完成安全修复并运行相关验证。'
```

可选参数：

- `--id <id>`：指定可追踪的 Goal ID；
- `--max-steps <1-1000>`：覆盖默认安全步数上限；
- `--provider codex-app-server`：使用本机已配置的 Codex app-server 适配器。

`orchestrate` 会返回 JSON 摘要；退出码为 `0` 表示完成，`3` 表示需要人工处理，其他非零值表示执行失败。所有 Goal 数据仍写入 `AGENTSCOPE_DATABASE` 指向的 SQLite 文件，Dashboard 可同时查看。

## 4. 与普通 TTY 的区别

Orchestrator 的 Worker 使用 provider 的非交互执行入口，以便稳定记录 Attempt、退出码和结构化结果；它不是完整的多轮 TTY 会话。

如果需要像平常一样进行多轮 TTY 对话，继续使用现有命令：

```powershell
node .\apps\cli\bin\agent-scope.mjs claude --agent-scope-accept-api-key
node .\apps\cli\bin\agent-scope.mjs codex
```

TTY 会话仍然进入 Monitor 的 Session/Turn/Timeline 页面；Orchestrator Goal 则额外提供 Task/Attempt/Verification 层级。

## 5. 状态和人工介入

- `CREATED/PLANNING/RUNNING/VERIFYING`：系统正在准备、执行或验证。
- `PAUSED`：用户主动暂停；只在安全边界继续，不复制活动 Attempt。
- `NEEDS_HUMAN`：证据不确定、重试耗尽、运行时异常或检测到 Gap，需要人工检查后再 Continue 或 Abort。
- `COMPLETED`：所有 Task 和最终 Goal 复核均有通过证据。
- `FAILED`：系统确认失败；不会把 Worker 的一句“完成”直接当作完成。
- `ABORTED`：用户主动终止。

验证失败默认最多重试三次。最终复核若确定失败，会创建一个带失败证据的 Gap Task 并停在 `NEEDS_HUMAN`；不会无限自动修改文件。

## 6. 数据和安全边界

- Goal、Task、Attempt、Verification 和 Event 都持久化到 SQLite，服务重启后可恢复查看。
- Project Context 只读取 Git/manifest/README/目录和可发现命令摘要，过滤 `.env`、token、secret、credential、key 等敏感路径。
- Verifier 只执行结构化 `executable + args` 命令，不拼接 shell 字符串；不安全或无法确认的结果显示为 `UNCERTAIN`。
- Worker 不允许推送远程仓库；V0 不启用并行 Worker、DAG、worktree 或自动 merge。
- 终态 Goal 可在详情页归档/恢复；归档只隐藏历史并写入审计事件，不删除关联数据。Session 的 Hide/Delete 仍是独立的清理操作。
