# V0 手工 CLI Smoke 清单

这份清单只验证本机 Claude Code/Codex CLI 进程和 AgentScope 的监控链路，不要求官方 Anthropic API。API endpoint、model 和 key 由运行者在当前 PowerShell 会话中自行配置，不写入仓库、日志或 fixture。

## 1. 前置检查

在 PowerShell 中进入仓库根目录，并确认 CLI 可执行：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
claude --version
codex --version
```

如果使用兼容 Claude API 的 endpoint，继续使用你自己的现有环境变量配置；不要把 key 粘贴到命令输出或提交中。

## 2. 启动 AgentScope 服务

```powershell
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs start
```

另开一个 PowerShell 窗口启动 Dashboard（开发态）：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
pnpm --filter @agentscope/dashboard dev
```

浏览器打开 `http://localhost:5173`，服务 API 默认在 `http://127.0.0.1:8787`。

## 3. Claude Code structured smoke

在已经配置 provider 环境变量的窗口执行一个无敏感、无文件修改的最小任务：

```powershell
node .\apps\cli\bin\agent-scope.mjs run claude -- --bare -p "Reply with OK only" --output-format stream-json --verbose
```

完成后，在第二个窗口确认 session 和 timeline：

```powershell
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs sessions
node .\apps\cli\bin\agent-scope.mjs show <实际 session id>
```

记录：CLI 版本、session status、eventCount、是否出现 `session_started`/`agent_message`/`session_finished`、退出码，以及 Dashboard 是否同步显示。

## 4. Codex structured smoke

adapter 默认使用已实测的 `codex exec --json --ephemeral` 路径。根据本机 CLI 的公开 `codex exec` 参数，在 `--` 后传入你的最小 prompt/权限参数；不要把 provider 原始输出提交到仓库：

```powershell
node .\apps\cli\bin\agent-scope.mjs run codex -- <codex exec 参数>
```

记录同样的生命周期、命令失败、退出码和 Dashboard 展示结果。若 CLI 需要额外登录、审批或网络权限，保留诊断信息即可，不要绕过安全提示。

## 5. 中断与失败补测

- 让 Claude/Codex 执行一个短暂运行的命令，在 wrapper 窗口按 `Ctrl+C`，确认最终状态是 `interrupted`，而非 `completed`。Windows PowerShell 可能会先终止外层 CLI，导致 Dashboard 暂时显示 `running`；确认 provider 子进程已结束后，在同一数据库配置下运行 `node .\apps\cli\bin\agent-scope.mjs recover`，再确认会话变为 `interrupted`。
- 运行一个明确返回非零退出码的测试/命令，确认 timeline 有 command/test failure，最终状态不会伪装成成功。
- 只提交脱敏后的 status/show 输出和版本信息；不要提交 key、完整 prompt、命令正文、绝对路径或原始 stdout。

真实 smoke 尚未在 CI 自动执行；它依赖本机 CLI 安装、当前 endpoint/model 和用户确认的网络/审批行为。
