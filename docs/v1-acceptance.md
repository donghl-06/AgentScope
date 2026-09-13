# AgentScope V1 验收矩阵

日期：2026-09-13
范围：Windows native PowerShell + VS Code、此前用户确认的 WSL2 同库联动、脱敏的 Mock/结构化回归，
以及隔离临时数据库中的真实 Claude/Codex 安全任务。

这份矩阵记录当前可以声明的能力边界。`Verified` 表示有自动化或用户确认的证据；`Conservative` 表示功能
已实现，但故意不对 Provider 未报告的语义做推断；`Pending` 表示需要目标 Provider、目标平台或更长时间/
更大规模实验后才能声明。完整 release gate 的计数见 [V1 Release Gate 记录](findings/v1-release-gate.md)。

| 能力 | 状态 | 证据/边界 |
| --- | --- | --- |
| Claude structured 生命周期、Provider metadata、usage/tool/native event 归一化 | Verified | `packages/adapters/claude-code` fixtures、unit/integration tests、[真实 Provider 记录](findings/v1-real-provider-acceptance.md) |
| Claude Windows 交互式 TTY 多轮 | Verified | Windows PowerShell 人工 smoke：多轮、审批、Ctrl+C、resize、同库 Dashboard 联动 |
| Codex Windows 交互式 TTY 多轮 | Verified | Codex fake PTY/Windows shim 回归；用户确认真实 Codex 多轮和 Dashboard 监控 |
| TTY turn projection、observer evidence、实时 ETA/progress | Verified / Conservative | TTY 显示 AgentScope observer 投影；原生 tool/milestone/token/精确 ETA 不宣称 |
| Dashboard 实时更新、刷新、WebSocket 重连和 HTTP cursor catch-up | Verified | Server/LiveHub 集成测试、跨进程 SQLite smoke、事件延迟与重连记录 |
| Dashboard Turns/Timeline 搜索筛选和 evidence 关联 | Verified | Dashboard 回归与人工验收；无 Turn 时明确显示空状态，不伪造任务 |
| Edge 桌面通知 | Verified | 权限请求状态机、去重测试和用户确认的 Edge acceptance |
| WSL2 真实 Claude 与 Windows Dashboard 同库联动 | Verified (prior manual) | 用户此前确认 WSL2 转发、真实 Claude 和同库 Dashboard；本次不重复消耗真实配额 |
| `--resume <id>` 保守记录和按 ID 展示关联 execution | Verified | protocol/schema/reducer/provider-runner tests；每次 execution 仍保持独立 |
| `--continue` 自动识别原生会话 | Conservative | 只记录 continuation request；没有稳定 Provider ID 时不自动合并 |
| Session Hide/Delete 与历史 ETA | Verified / Conservative | 终态 Session 可隐藏或级联删除；运行中拒绝清理；历史样本不足时显示 cold-start |
| Goal 历史分页、筛选、搜索与稳定排序 | Verified | storage/server/dashboard 分页和组合筛选测试；详情不随列表一次性加载 |
| Goal Archive/Restore | Verified | 非活动 Goal 可归档/恢复；默认历史隐藏归档项；Task/Attempt/Verification/Event 保留；事务审计事件且重复调用幂等 |
| stale Session 下的 active Turn 恢复 | Verified | `agent-scope recover` 收敛 queued/running/waiting Turn 为 `interrupted`，保留 blocked，写入有界 recovery evidence |
| 真实 Provider 的 resume 成功/无效 ID/并发 resume 语义 | Pending | 需要在目标 Provider/account 上做行为验收，不能由 CLI help 或 Mock 推断 |
| Codex structured JSONL usage/tool/native event 归一化 | Verified / Conservative | Codex fixtures、parser/adapter 回归和隔离真实 Codex 任务；cost、native milestone 未稳定观测 |
| Codex 交互式 TTY 中的原生 token/tool/milestone/精确 ETA | Unavailable by design | 继续使用 structured 或 app-server 获取 Provider 原生可观测字段；TTY 只显示 observer 投影 |
| Codex app-server 本地结构化接入 | Verified / Conservative | 本机 Codex schema/protocol 回归覆盖 start、resume、interrupt、item/tool/file/plan/usage 和审批拒绝；官方 Desktop App 直接附着、稳定 cost/精确 ETA 不宣称 |
| Human Instruction、Continue/Resume/Retry、roadmap revision、Approval、Lease | Verified / Conservative | 状态机、跨包控制闭环和故障恢复矩阵；所有修改仍受 safe boundary、幂等和 Verifier 约束 |
| False completion 回归 | Verified | Worker 失败但 Verifier PASS 会被降级为 FAIL；缺证据/缺 requirement 不得完成 |
| Progress/ETA 冷启动与历史校准 | Verified / Conservative | 0/少量/充足样本、outlier、历史超时和终态 100% 的确定性测试；不足样本不承诺精确预测 |
| 性能、批量分页、广播和短时串行稳定性 | Verified (diagnostic) | 180 Goal/720 Task/4520 Event、200 广播、120-cycle soak；见 [V1 性能基线](findings/v1-performance-baseline.md)，不等于容量/SLO |
| Windows/WSL2 Unicode workspace | Verified / Conservative | Windows 自动化和此前用户 WSL2 同库验收；完整 WSL2 真实 PTY 仍需目标机确认 |
| macOS | Not run | 当前工作主机没有 macOS；获得目标主机后运行同一套 smoke |
| 长时间、多小时、浏览器 paint 和支持容量上限 | Pending | 当前数字是诊断基线，不是生产容量或 P95 承诺 |

## 自动化与真实验收证据

- [V1 真实 Provider 安全验收](findings/v1-real-provider-acceptance.md)：隔离临时数据库中的 Claude 写入/验证、失败修复和 Codex structured 只读任务。
- [V1 Progress/ETA 校准](findings/v1-progress-eta-calibration.md)：冷启动、样本过滤、历史超时和完成门槛。
- [V1 性能与短时稳定性](findings/v1-performance-baseline.md)：历史分页、Goal 详情、广播与 120-cycle soak。
- [Monitor 与跨平台回归](findings/v1-monitor-platform-compatibility.md)：Windows 自动化、WSL2 既有手工证据、macOS 未执行边界。
- [Known Issues](known-issues.md)：TTY 原生遥测、app-server 审批、恢复和平台限制。

## Release gate 状态

2026-09-13 的本地 `pnpm release:check` 已通过：88 个测试文件、478 项单元测试，5 个集成文件、17 项集成测试；
fixture、Lint、全 workspace typecheck、build/manifest、生产依赖审计和 V1 专项验收也已通过。真实 Provider、浏览器
绘制、macOS 和多小时容量不属于本地自动门禁，继续按上表保留边界。完整记录见
[V1 Release Gate 记录](findings/v1-release-gate.md)。
