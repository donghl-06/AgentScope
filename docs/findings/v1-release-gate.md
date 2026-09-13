# AgentScope V1 Release Gate 记录

**日期：** 2026-09-13
**分支：** `codex/orchestrator-v1`
**策略：** 仅本地提交，不推送远程

## 强制门禁

最后一次 `pnpm release:check` 的结果为通过：

| 门禁 | 结果 |
| --- | --- |
| `pnpm format:check` | 通过 |
| `pnpm fixtures:check` | 通过，5 个 JSONL fixture 无敏感信息 |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过，22 个 workspace package/app |
| `pnpm test` | 通过，88 个测试文件、478 项测试 |
| `pnpm test:integration` | 通过，5 个测试文件、17 项测试 |
| `pnpm build` | 通过，workspace manifest check 通过 |
| `pnpm audit --prod` | 通过，No known vulnerabilities found |

## V1 专项验收

- Goal Archive/Restore：storage、Server HTTP、Dashboard API 和幂等审计事件测试通过；活动 Goal 归档返回
  409，历史数据不删除。
- V0→V1 migration：临时数据库从空库和已有 `0000_initial` 数据升级；独立 migration runner 已与 storage
  包保持 `0000–0011` 一致，共 12 个 migration。
- Fault recovery：控制闭环、崩溃恢复和 false-completion 矩阵通过，无双 Attempt、半个 revision 或静默丢失指令。
- Progress/ETA：冷启动、少量/充足历史、异常样本、历史超时和终态 100% 规则通过。
- 性能/短时稳定性：180 Goal、720 Task、4520 Event 的分页/详情/广播基线，以及 120 次串行闭环无遗留活动状态。
- 真实 Provider：隔离临时数据库中的 Claude 写入/验证、失败修复和 Codex structured 只读任务已记录；不重复消耗用户
 真实额度。
- Monitor/平台：Windows 自动化 12 个测试文件、91 项通过；WSL2 使用此前用户确认的同库证据；macOS 未执行。

## 发布判断

V1 本地 release gate 已通过，可以作为 Windows 目标环境的本地 release candidate 使用。真实 Provider 的账号、网络、
终端审批、多小时容量、浏览器 paint、完整 WSL2 真实 PTY 和 macOS 仍按验收矩阵标记为 Conservative/Pending/Not run，
不被本门禁升级为生产承诺。
