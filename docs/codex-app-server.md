# Codex app-server + AgentScope

本文说明 AgentScope 对 Codex CLI `app-server` 的实验性结构化接入。它和
`agent-scope codex` 的 TTY wrapper 是两条并存的路径：TTY 优先保证原生终端和
多轮对话体验，app-server 优先保证 provider 原生事件的可观测性。

## 已验证范围

本机安装的 `codex-cli 0.153.4` 提供了 `codex app-server` 和
`codex app-server generate-json-schema`。AgentScope 根据这个实际安装版本生成并
检查 JSON Schema，然后只在 `packages/adapters/codex-app-server` 中解析 JSON-RPC
事件。仓库不提交生成的 schema，因为 Codex 版本升级后字段可能变化。

适配器已覆盖这些协议生命周期：

- `initialize`、`thread/start`、`thread/resume`、`turn/start`；
- `thread/started`、`thread/status/changed`、`turn/started`、`turn/completed`；
- `item/started` / `item/completed` 中的命令、工具、文件变化、计划和 agent message；
- `thread/tokenUsage/updated`、`turn/plan/updated` 和可重试/最终错误；
- `turn/interrupt`（停止 AgentScope 会话时发送）；
- 无交互审批界面时，对命令/文件/权限/用户输入/MCP elicitation 请求做保守拒绝或空响应，
  同时在 Dashboard 标记 `blocked`，绝不自动批准未知动作。

不支持把已经在官方 Codex Desktop App 中运行的任务“附着”到 AgentScope；官方 app
没有在本项目目标版本中提供稳定的外部附着入口。AgentScope 自己启动的本地
app-server 进程是当前可复现的路径。

## 使用方式

先在第一个终端启动后端和 Dashboard：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start
```

然后打开 `http://127.0.0.1:5173/`，在第二个终端运行一次结构化 app-server turn：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs run codex-app-server -- "Reply with APP_SERVER_OK only"
```

需要在已有 Codex thread 上继续一轮时，使用明确的 provider thread id：

```powershell
node .\apps\cli\bin\agent-scope.mjs run codex-app-server -- `
  --resume <codex-thread-id> "Continue the task and reply with RESUMED_OK only"
```

`run codex-app-server` 是一次启动、一次 turn、一次完成的结构化命令；它不是
交互式聊天输入框。需要像正常 Codex 一样持续输入多轮任务、保留审批/slash 命令、
调整终端大小时，使用：

```powershell
node .\apps\cli\bin\agent-scope.mjs codex --no-alt-screen
```

TTY 和 app-server 可以同时运行，只要它们指向同一个
`AGENTSCOPE_DATABASE`，Dashboard 会按独立 session 展示。

## Dashboard 中的含义

| app-server 信号 | AgentScope 展示 |
| --- | --- |
| Codex thread id、model、CLI version | Session info / provider metadata |
| turn started/completed | Turns、Timeline、实时状态 |
| command execution item | Tool call + command/test/build/typecheck 事件 |
| fileChange item | File evidence |
| plan item、turn plan update | Milestone / planning |
| tokenUsage update | Token usage（仅显示 provider 实际报告的字段） |
| approval/status request | Blocked 或 waiting；非交互 wrapper 不会自动批准 |
| 未报告的 cost、精确 ETA 或字段 | `Unavailable`，不做推断 |

每条原生 JSON-RPC 通知都会留下脱敏的 `provider_event`，但不会保存 prompt、命令
全文、agent message 正文、环境变量或完整原始 payload。命令文本最多在内存中用于
判断测试/构建/类型检查类别。

## 网络和版本限制

app-server 仍需要 Codex 自己的登录、模型、代理和网络。AgentScope 启动协议进程
成功，不代表 provider 请求一定成功；TLS 证书、代理或并发限制会在 Dashboard 中以
provider error/retry 表现。出现 `UnknownIssuer`、连接失败或长时间 retry 时，先在
同一终端确认原生 `codex` 网络可用。

升级 Codex CLI 后建议重新运行：

```powershell
codex --version
codex app-server generate-json-schema --out <temporary-directory>
```

如果新版本改变方法或通知名，适配器会保留未知事件的脱敏 `provider_event`，并把
没有稳定映射的字段显示为 unavailable，而不是把旧字段误当成新语义。

