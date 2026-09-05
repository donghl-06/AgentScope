# AgentScope

AgentScope 是一个本地优先的 AI Coding Agent 可观测平台。V0 聚焦 Claude Code CLI 与 Codex CLI，通过统一事件协议、状态引擎、SQLite、HTTP/WebSocket 和 React Dashboard 展示可信的任务状态、进度与区间 ETA。

当前仓库已经完成 Claude Code CLI、Codex CLI 的 structured adapter、SQLite
存储、HTTP/WebSocket 服务和 Dashboard 的第一条可运行纵向切片。真实 CLI smoke
已在 Windows native PowerShell 上完成；剩余工作集中在 observer fallback、TTY/WS
恢复、性能边界和 V0 发布验收。需求、实施顺序和验收标准见：

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

安装依赖后，启动本地后端和 Dashboard：

```powershell
pnpm install
pnpm --filter @agentscope/dashboard dev
```

另一个终端启动 AgentScope server：

```powershell
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs start --host 127.0.0.1 --port 8787 --database $env:AGENTSCOPE_DATABASE
```

Dashboard 默认地址为 `http://localhost:5173/`。没有真实 Agent 或 API 配置时，
可以使用脱离网络的 Mock fixture：

```powershell
node .\apps\cli\bin\agent-scope.mjs run mock --fixture basic-success
```

真实 Claude/Codex smoke 的命令、隐私约束和已知限制见
[`docs/manual-smoke.md`](docs/manual-smoke.md)。

常见路径、端口、数据库、CLI 无输出、并发限制和 Windows 进程问题见
[`docs/troubleshooting.md`](docs/troubleshooting.md)。

数据库迁移、备份、恢复和回滚操作见
[`docs/storage-operations.md`](docs/storage-operations.md)；版本变更见
[`CHANGELOG.md`](CHANGELOG.md)。

后续实施、验证和发布门禁以 `ROADMAP.md` 的 Phase/Step 记录为准。
