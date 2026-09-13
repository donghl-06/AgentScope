# V1 Monitor 与跨平台回归矩阵

**更新日期：** 2026-09-13  
**本次自动化主机：** Windows `win32-x64`、Node.js `v24.14.1`  
**范围：** 原有 Monitor TTY/structured/app-server、Dashboard 实时链路、历史清理和
跨平台证据边界。

## 回归结论

| 场景 | 状态 | 证据与边界 |
| --- | --- | --- |
| Windows 原生 Claude TTY | Verified | PTY/输入/输出/resize/Ctrl+C/多轮 turn 的自动化回归；真实 GLM-backed TTY、Dashboard 联动和 Unicode 路径由此前验收确认 |
| Windows 原生 Codex TTY | Verified | Codex `›` prompt、Node shim、PTY 生命周期和多轮投影回归；真实 Codex TTY 与 Dashboard 由此前验收确认 |
| Claude structured | Verified | stream parser、tool/usage/native event、失败/截断/退出路径回归 |
| Codex structured | Verified | JSONL parser、usage/tool/command/失败/中断路径回归；未报告的 milestone/cost 仍显示 Unavailable |
| Codex app-server | Verified / Conservative | JSON-RPC start/resume/interrupt、item/tool/file/plan/usage 和审批拒绝回归；官方 Desktop App 直接附着仍不支持 |
| Dashboard HTTP/WS 实时广播 | Verified | committed event、跨进程 SQLite writer、断线重连/快照、慢客户端和 ghost event 回归 |
| Session 隐藏/删除 | Verified | 终态可隐藏或级联删除；运行中 Session 保留并拒绝清理，避免中断外部进程 |
| Orchestrator 通知 | Verified | 去重、读/忽略、跨进程广播和 sink 故障隔离回归；浏览器权限由此前 Edge 人工验收确认 |
| Windows Unicode/空格路径 | Verified | 原生 process runner、provider runner 和 PTY 回归保持路径/参数原样 |
| WSL2 Claude 与 Windows Dashboard 同库 | Verified (prior manual) | 用户此前确认 WSL2 转发、真实 Claude 和 Windows Dashboard 同库联动；本次未在 Windows 主机重装 WSL2 环境 |
| WSL2 完整交互 PTY | Conservative | 既有 node-pty Linux smoke 已通过；完整真实 TTY 行为仍需目标 WSL2 主机的人工验收，不从 Windows 自动化推断 |
| macOS | Not run | 当前工作主机没有 macOS；待拥有目标主机后运行同一套 smoke，不影响 Windows/WSL2 路径的声明 |

## 本次自动化命令

```text
node node_modules/.pnpm/vitest@*/node_modules/vitest/vitest.mjs run --disableConsoleIntercept apps/cli/src/interactive-runner.test.ts apps/cli/src/provider-runner.test.ts packages/terminal/src/node-pty-driver.test.ts packages/terminal/src/session.test.ts packages/adapters/claude-code/src/adapter.test.ts packages/adapters/claude-code/src/parser.test.ts packages/adapters/codex-cli/src/adapter.test.ts packages/adapters/codex-cli/src/parser.test.ts packages/adapters/codex-app-server/src/adapter.test.ts packages/adapters/codex-app-server/src/parser.test.ts apps/server/src/live-hub.test.ts apps/server/src/index.test.ts
```

结果：**12 个测试文件、91 项测试全部通过**。这些测试使用 fake provider、临时数据库或
本地进程，不访问真实 API，也不读取或保存 API key。

## 兼容性边界

1. Monitor 的 `run claude`、`run codex` structured 路径和交互式 `claude`/`codex` TTY
   路径继续并存；TTY 的 progress/ETA/evidence 是 AgentScope observer 投影，不会伪造
   Provider 未提供的 token、tool、milestone 或 cost。
2. `codex-app-server` 是独立的细粒度结构化入口，不改变 Codex TTY 的默认体验；没有审批
   UI 时，app-server 请求按保守策略拒绝或进入可解释的阻塞状态。
3. Dashboard 通过 HTTP 快照和 WebSocket 增量共同恢复；刷新、重连或跨进程写入不会要求
   前端猜测遗漏的事件，也不会把同一事件重复显示为新的 timeline 项。
4. 删除操作只针对终态 Session；活动 Session 没有删除入口/会被后端拒绝。隐藏是可逆的
   历史整理操作，删除是级联清理操作，二者都不会自动终止外部 Provider。

## 发布判断

Windows 原生回归和已有 WSL2 用户验收支持 V1 的 Monitor 兼容性声明；macOS 以及 WSL2
完整交互 PTY 仍是平台条件满足后的补充验收，不阻塞当前 Windows/WSL2 目标，但必须在
发布说明中保持 `Not run`/`Conservative` 标签，直到有对应主机证据。
