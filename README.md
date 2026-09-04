# AgentScope

AgentScope 是一个本地优先的 AI Coding Agent 可观测平台。V0 聚焦 Claude Code CLI 与 Codex CLI，通过统一事件协议、状态引擎、SQLite、HTTP/WebSocket 和 React Dashboard 展示可信的任务状态、进度与区间 ETA。

项目目前处于工程初始化阶段。需求、实施顺序和验收标准见：

- `AgentScope_Codex实施规格.md`
- `AgentScope_项目规划_用户版.md`
- `ROADMAP.md`

## 仓库分层

- `apps/`：可运行的服务端、Dashboard 和 CLI。
- `packages/`：协议、核心状态、Adapter、Observer、Progress、ETA、Storage 等可复用模块。
- `docs/`：架构、协议、隐私、Adapter 指南、实验结论和决策记录。
- `scripts/experiments/`：Phase 0 能力实测脚本。
- `tests/fixtures/`：脱敏的原始样例与标准化事件样例。

在第一个可运行纵向切片完成前，以 `ROADMAP.md` 的 Phase/Step 门禁为实施依据。
