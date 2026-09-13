# AgentScope Orchestrator V1 发布说明

**状态：** 本地 V1 release candidate（不自动推送远程）  
**日期：** 2026-09-13  
**分支：** `codex/orchestrator-v1`

AgentScope Orchestrator V1 把 V0 的单 Worker 执行链路升级为可干预、可恢复、可审计的本地 Agent Control
Center。它仍然坚持一个活动 Goal、一个活动 Task、一个 Worker Attempt，并以独立 evidence/Verifier 为完成
依据。V1 不把系统扩展成并行调度器，也不替 Provider 猜测不存在的 telemetry。

## 已交付能力

- Goal 历史稳定 cursor 分页、状态/Provider/Workspace/文本筛选和搜索；
- PAUSED、NEEDS_HUMAN、COMPLETED、FAILED、ABORTED Goal 的安全 Archive/Restore；归档事务留下
  `goal.archived`/`goal.unarchived` 审计事件，Task/Attempt/Verification/Event 不删除；
- Human Instruction 的 pending/applied/rejected/superseded 语义，以及 Continue/Resume/Retry/Abort 的
  safe-boundary、幂等和冲突保护；
- immutable Roadmap Revision，未来 Task 编辑/插入/跳过/重排和 LOCKED 约束；
- Execution Memory、Working Set、Approval、GoalRunLease、预算和 Orchestrator Notification 持久化；
- evidence-based Goal/Task Progress、ETA range、confidence、reason 和冷启动/历史超时校准；终态完成进度固定
  为 100%，没有验证证据时不伪造完成；
- Dashboard Control Center：Goal/Task/Attempt/Session 导航、实时广播、断线恢复、通知、控制反馈和异常空状态；
- Claude 与 Codex structured/TTY 运行链路保持并存；Codex app-server 提供本地细粒度 JSON-RPC 入口；
- 故障注入、真实 Provider 隔离验收、批量历史/广播/短时串行稳定性和 Windows Monitor 回归。

## Claude 与 Codex 能力边界

| 能力 | Claude | Codex |
| --- | --- | --- |
| 交互式 TTY 多轮 | Windows 已验证；WSL2 有此前用户确认的同库证据 | Windows 已验证；WSL2 受目标终端环境限制 |
| TTY 实时进度/evidence | AgentScope observer 的 PTY/进程/文件/Git 投影 | 同一套 observer 投影；不伪造 Provider 私有字段 |
| Structured JSONL | stream、tool、command、usage、hook 等已观测字段可归一化 | thread/turn/item、tool、command、usage 等已观测字段可归一化 |
| 原生 token/tool/milestone | 只在 structured 输出实际报告时展示；TTY 不保证 | structured/app-server 可提供部分字段；TTY 不保证，milestone/cost 未稳定观测 |
| 精确 ETA | Provider 未提供稳定未来 ETA；使用历史/observer 估算 | 同样使用 AgentScope 估算；无可靠数据时 `Unavailable` |
| 多轮会话关联 | 显式 `--resume` 安全记录；`--continue` 不猜测合并 | `resume <id>` 安全记录；`resume --last` 只记录 continuation request |
| app-server | 不适用 | 本地 JSON-RPC 一轮入口；当前审批 UI 不完整，风险请求保守阻塞 |

完整矩阵见 [V1 验收矩阵](v1-acceptance.md)，真实任务细节见[真实 Provider 验收记录](findings/v1-real-provider-acceptance.md)。

## 使用入口

新用户请从[《Orchestrator V1 使用指南》](orchestrator-v1-user-guide.md)开始。最常用的命令是：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start
```

然后：

- 浏览器打开 <http://127.0.0.1:5173/>，确认 `Live updates connected`；
- 正常多轮 Claude：`node .\apps\cli\bin\agent-scope.mjs claude --agent-scope-accept-api-key`；
- 正常多轮 Codex：`node .\apps\cli\bin\agent-scope.mjs codex`；
- 自动化 Goal：`node .\apps\cli\bin\agent-scope.mjs orchestrate --provider claude --workspace <path> --prompt <goal>`；
- Server 重启后的保守恢复：`node .\apps\cli\bin\agent-scope.mjs recover`。

## 数据升级与回滚

打开旧数据库会自动顺序应用 `0006_orchestrator` 至 `0011_observer_evidence_attempt`。不要删除或修改已经
应用的 migration，也不要手工反向 SQL。升级前停止写入并备份 `.db`、`-wal`、`-shm`；升级失败时把当前目录
隔离，使用确切 commit 和恢复副本检查 `/healthz`、Session 和 Goal 详情。详见[运维与恢复指南](orchestrator-v1-operations.md)。

## 已知限制与 V2 延后项

- 普通 TTY 无法读取 Claude/Codex 私有结构化 usage、tool、milestone 或精确 ETA；请使用 structured/app-server；
- app-server 当前没有完整的 AgentScope 审批 UI；需要人工审批的请求按保守策略阻塞；
- WSL2 完整真实 PTY 和 macOS 尚未在当前 Windows 主机执行；
- 当前性能数据是合成短时诊断基线，不是多小时容量、浏览器 paint 或生产 P95/SLO 承诺；
- V1 不提供多 Worker 并行、DAG、Remote Worker、跨 Provider 智能路由、自动 merge、团队权限或官方 Desktop App 附着；
- 原始 Provider log 默认不落库，也没有稳定的长期 retention/清理命令。

这些限制都在 Dashboard 中以 `Unknown`、`Unavailable`、`Conservative` 或 `Pending` 表达，不会被静默包装成已支持功能。

## 验证状态

Phase 12.4 会运行 `pnpm release:check` 并在最终本地提交中记录完整计数。此前的专项证据包括：

- 真实 Claude/Codex 隔离安全任务与失败修复；
- Progress/ETA 校准矩阵；
- 180 Goal/720 Task/4520 Event 的历史分页、详情和广播基线，以及 120-cycle 串行 soak；
- Windows 12 个 Monitor/Provider/Server 测试文件、91 项回归通过；
- Goal Archive/Restore 存储、API 和幂等审计测试通过。

Phase 12.4 完成前，本文档的“本地 V1 release candidate”不等同于远程发布或生产容量承诺。
