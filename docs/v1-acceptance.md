# AgentScope V1 验收矩阵

日期：2026-09-09  
范围：Windows native PowerShell + VS Code、WSL2 同库联动，以及脱敏的 Mock/结构化回归。

这份矩阵记录当前可声明的能力边界。`Verified` 表示已有自动化或用户确认的证据；
`Conservative` 表示功能已实现，但故意不对 provider 未报告的语义做推断；`Pending`
表示需要真实 provider 行为或更长时间/更大规模实验后才能声明。

| 能力 | 状态 | 证据/边界 |
| --- | --- | --- |
| Claude structured 生命周期、provider metadata、usage/tool/native event 归一化 | Verified | `packages/adapters/claude-code` fixtures、unit/integration tests、GLM smoke findings |
| Claude Windows 交互式 TTY 多轮 | Verified | Windows PowerShell 人工 smoke：多轮、审批、Ctrl+C、resize、同库 Dashboard 联动 |
| TTY turn projection、observer evidence、实时 ETA/progress | Verified | interactive runner tests、Windows/WSL2 人工验收；TTY 中原生 tool/milestone/token 仍不宣称 |
| Dashboard 实时更新、刷新、WebSocket 重连和 HTTP cursor catch-up | Verified | integration tests、`event-latency-smoke.mjs`、`ws-reconnect-smoke.mjs` |
| Dashboard Turns/Timeline 搜索筛选和 evidence 关联 | Verified | Dashboard 回归与人工验收；无 turn 时明确显示空状态，不伪造任务 |
| Edge 桌面通知 | Verified | 权限请求状态机、去重测试和用户确认的 Edge acceptance（2026-09-09） |
| WSL2 真实 Claude 与 Windows Dashboard 同库联动 | Verified | 用户确认的 WSL2 转发/同库测试；provider 并发限制属于外部 endpoint 行为 |
| `--resume <id>` 保守记录和按 id 展示关联 execution | Verified | protocol/schema/reducer/provider-runner tests；每次 execution 仍保持独立 |
| `--continue` 自动识别原生会话 | Conservative | 只记录 continuation request；没有稳定 provider id 时不自动合并 |
| 真实 provider 的 resume 成功/无效 id/并发 resume 语义 | Pending | 需要在目标 provider/account 上做行为验收，不能由 CLI help 或 Mock 推断 |
| Codex 交互式 TTY 多轮会话 | Pending | 当前 Codex 仍以 structured adapter 为主，按用户决定暂后置 |
| 长时间、多小时、浏览器 paint 和支持容量上限 | Pending | 当前性能数值是诊断基线，不是容量或 SLO 承诺 |

## 自动化 release gate

最后一次本地 `pnpm release:check`（2026-09-09）通过：格式检查、fixture 脱敏检查、
lint、全 workspace typecheck、55 个 unit test 文件/253 个测试、5 个 integration tests、
workspace build 和 manifest check。真实 provider、浏览器绘制和容量边界不在该门禁中。

## 相关证据

- [`docs/findings/e2e.md`](findings/e2e.md)：性能、重启、WebSocket 和跨进程实验结果。
- [`docs/findings/claude-capabilities.md`](findings/claude-capabilities.md)：Claude CLI 能力和 TTY 边界。
- [`docs/v0-acceptance.md`](v0-acceptance.md)：V0 structured/API 验收。
- [`docs/known-issues.md`](known-issues.md)：当前不宣称的能力和限制。
