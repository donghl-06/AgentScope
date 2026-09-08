# AgentScope

AgentScope 是一个本地优先的 AI Coding Agent 可观测平台。V0 聚焦 Claude Code CLI 与 Codex CLI，通过统一事件协议、状态引擎、SQLite、HTTP/WebSocket 和 React Dashboard 展示可信的任务状态、进度与区间 ETA。

当前仓库已经完成 Claude Code CLI、Codex CLI 的 structured adapter、Claude
交互式 TTY wrapper、SQLite 存储、HTTP/WebSocket 服务和 Dashboard 的可运行纵向切片。
Windows native PowerShell、WSL2 同库联动、通知和 release gate 均已有验收证据；
仍在收口的内容主要是 provider-specific resume 语义和更长时间/更大规模边界。
需求、实施顺序和验收标准见：

- `AgentScope_Codex实施规格.md`
- `AgentScope_项目规划_用户版.md`
- `ROADMAP.md`

## 仓库分层

- `apps/`：可运行的服务端、Dashboard 和 CLI。
- `packages/`：协议、核心状态、Adapter、Observer、Progress、ETA、Storage 等可复用模块。
- `docs/`：架构、协议、隐私、Adapter 指南、实验结论和决策记录。
- `scripts/experiments/`：Phase 0 能力实测脚本。
- `tests/fixtures/`：脱敏的原始样例与标准化事件样例。

## Quick start

安装依赖后，从仓库根目录用一条命令启动本地后端和 Dashboard：

```powershell
pnpm install
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start -- --host 127.0.0.1 --port 8787 --database $env:AGENTSCOPE_DATABASE
```

默认 Dashboard 地址为 `http://127.0.0.1:5173/`。`Ctrl+C` 会同时关闭后端和 Dashboard；
只启动后端时追加 `--no-dashboard`，修改 Dashboard 端口时使用 `--dashboard-port <port>`。

没有真实 Agent 或 API 配置时，
可以使用脱离网络的 Mock fixture：

```powershell
node .\apps\cli\bin\agent-scope.mjs run mock --fixture basic-success
```

真实 Claude/Codex smoke 的命令、隐私约束和已知限制见
[`docs/manual-smoke.md`](docs/manual-smoke.md)。

如果你在 VS Code PowerShell 中使用 Claude Code 配置 Kimi API，并希望实时
观察 Dashboard，请按
[`docs/claude-kimi-workflow.md`](docs/claude-kimi-workflow.md) 的双终端流程操作。

希望保留 Claude Code 的完整交互功能时，使用普通 TTY 模式（不要加 `--bare`）：

```powershell
. .\.env.claude-test.ps1
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs claude --agent-scope-accept-api-key
```

如果要显式续接 provider 会话，可在 Claude 参数中使用
`--resume <provider-session-id>`；AgentScope 会创建新的 execution record，并在
Dashboard 中按安全 id 展示关联执行。`--continue` 只记录“请求续接”，不会按工作目录、
prompt 或进程自动猜测会话，避免误合并不同任务。

提交前的本地发布门禁为 `pnpm release:check`，它会执行格式、fixture 脱敏、lint、
全 workspace typecheck、unit/integration tests 和 build。

常见路径、端口、数据库、CLI 无输出、并发限制和 Windows 进程问题见
[`docs/troubleshooting.md`](docs/troubleshooting.md)。

本地服务诊断指标和 `GET /api/diagnostics` 的字段说明见
[`docs/diagnostics.md`](docs/diagnostics.md)。

数据库迁移、备份、恢复和回滚操作见
[`docs/storage-operations.md`](docs/storage-operations.md)；版本变更见
[`CHANGELOG.md`](CHANGELOG.md)。

后续实施、验证和发布门禁以 `ROADMAP.md` 的 Phase/Step 记录为准。
