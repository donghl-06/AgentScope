# Codex app-server capability findings

## Test context

- 本机验证版本：`codex-cli 0.153.4`。
- 使用 `codex app-server generate-json-schema` 生成该版本的 v2 schema，并据此实现
  `@agentscope/adapter-codex-app-server`；schema 仅保存在临时目录，不进入仓库。
- 真实协议探针完成了 `initialize`、`thread/start`、`turn/start`、实时 notification
  解码和子进程生命周期；provider 网络请求因本机 TLS `UnknownIssuer` 重试，未把它
  误记为模型成功。
- 独立 fake JSON-RPC server 回归覆盖了 thread resume、turn interrupt、审批请求保守
  拒绝、命令/工具/文件/计划/usage 事件和最终 session 状态。

## Capability matrix

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| JSON-RPC stdio 启动 | Verified | AgentScope 启动 `codex app-server --listen stdio://` |
| thread/turn 生命周期 | Verified | start、resume、turn start/completed、interrupt |
| 原生 provider events | Verified | 统一为脱敏 `provider_event`，未知方法仍保留类型 |
| command/tool lifecycle | Verified | `item/started` / `item/completed` 归一化 |
| file changes | Verified | `fileChange` item 映射为文件证据 |
| plan/milestone | Verified when emitted | 仅在 Codex 实际发送 plan 时展示 |
| token usage | Verified when emitted | 只显示 `thread/tokenUsage/updated` 的字段 |
| approval | Conservative | 无 UI 时拒绝/空响应并标记 blocked，不自动放行 |
| 精确 cost / ETA | Unavailable | app-server 本次观察未提供稳定可用字段，不猜测 |
| 官方 Codex App 直接附着 | Not supported | 没有稳定外部 attach 合约 |

## 使用边界

app-server 适合需要细粒度 provider telemetry 的单次结构化任务；Codex TTY 仍是
多轮终端的首选。两条路径都写入同一个 AgentScope SQLite 数据库，Dashboard 可同时
观察。若任务需要人工审批或连续输入，应使用 TTY，而不是把 app-server 当作隐藏的
交互式终端。

