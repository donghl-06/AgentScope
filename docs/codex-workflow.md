# Codex CLI + AgentScope TTY workflow

本指南说明如何像使用原生 Codex CLI 一样进行多轮对话，同时让 AgentScope
在同一个 SQLite 数据库中记录 session、turn、进程/Git/文件证据和实时投影。
AgentScope 不替换 Codex 的交互界面，也不直接调用 Codex provider API；它只在
PTY 中启动本机的 `codex` 可执行程序并透明转发输入、输出和窗口大小。

## 1. 启动服务和 Dashboard

在 VS Code 的第一个 PowerShell 终端中，从 AgentScope 仓库启动服务：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start
```

保持这个终端运行，浏览器打开 `http://127.0.0.1:5173/`。默认后端端口是
`8787`，Dashboard 通过它接收跨进程实时更新。不要让两个 AgentScope server
同时打开同一个数据库；如果 `8787` 被占用，先确认并关闭旧 server，或为整套
实例换用一组新的端口和数据库。

## 2. 在第二个终端启动 Codex TTY

如果 Codex 要操作 AgentScope 仓库本身：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = 'D:\大学\项目\AgentScope\.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs codex --no-alt-screen
```

如果 Codex 要操作另一个项目，必须在那个项目目录启动 wrapper；数据库仍然指向
AgentScope 的共享数据库：

```powershell
Set-Location -LiteralPath 'D:\大学\其他项目\MyProject'
$env:AGENTSCOPE_DATABASE = 'D:\大学\项目\AgentScope\.agentscope\agentscope.db'
node 'D:\大学\项目\AgentScope\apps\cli\bin\agent-scope.mjs' codex --no-alt-screen
```

启动后，在同一个终端中输入 Codex 的普通任务并按 Enter。每一条普通任务会成为
一个独立 turn；Codex 回到 ready prompt 后，Dashboard 会把该 turn 标记为完成，
下一条输入会创建下一轮。PTY 保留 Codex 原生颜色、光标、多行编辑、审批、slash
命令和 Ctrl+C 行为。`--no-alt-screen` 只是让终端滚动内容更容易观察，不是
AgentScope 的必需参数。

Codex 的认证、配置、模型和网络代理仍由 Codex 自己负责。先在同一个终端确认
`codex --version` 和原生 `codex` 可以使用；AgentScope 不会替你登录或注入
provider key。若系统找不到 Codex，可设置本地环境变量（不要提交到 Git）：

```powershell
$env:AGENTSCOPE_CODEX_EXECUTABLE = 'C:\path\to\codex.cmd'
```

Windows npm 安装的 `.cmd` shim、Node JavaScript shim 和直接 `.exe` 均会被解析；
只有在默认 PATH 解析失败时才需要这个覆盖项。

## 3. 续接已有 Codex 会话

有明确 provider 会话 id 时，可以把它传给原生 Codex：

```powershell
node 'D:\大学\项目\AgentScope\apps\cli\bin\agent-scope.mjs' codex resume <provider-session-id>
```

`resume <id>` 会在新的 AgentScope execution 上记录显式 conversation id，Dashboard
可据此展示关联执行；每次启动仍保留独立 session。`resume --last` 只记录“请求续接”，
不会把不确定的“上一个会话”强行和历史执行合并。AgentScope 同样不会依据工作目录、
prompt 文本或进程关系猜测会话身份。

## 4. Dashboard 中能看到什么

- **Agent card**：provider、`codex-cli-tty` adapter、工作目录、session 状态和当前活动。
- **Progress / ETA**：根据 turn 边界、进程、Git、文件和验证 observer 推导的实时估计；
  是区间/置信度，不是 Codex 内部的精确进度或剩余时间。
- **Turns**：每轮任务的标题、耗时、状态和该轮 evidence 数量。
- **Observer evidence**：进程生命周期、Git 快照、文件变化和交互式边界等本地证据。
- **Timeline**：规范化 session/turn 事件，断线后由 WebSocket + HTTP cursor 补齐。

TTY 路径不会伪造 Codex 未公开的原生 token、tool call、milestone 或结构化事件。
如果将来 Codex 提供稳定的 TTY side-channel，再单独增加 provider-native 能力；
当前需要精确 usage/tool 数据时，继续使用既有的 `agent-scope run codex -- ...`
structured 路径。

## 5. 检查和恢复

```powershell
node 'D:\大学\项目\AgentScope\apps\cli\bin\agent-scope.mjs' sessions
node 'D:\大学\项目\AgentScope\apps\cli\bin\agent-scope.mjs' show <实际 session id>
```

若 Windows 控制台在 Ctrl+C 时先终止了外层 wrapper，确认 Codex 子进程已退出后，
用相同的 `AGENTSCOPE_DATABASE` 执行：

```powershell
node 'D:\大学\项目\AgentScope\apps\cli\bin\agent-scope.mjs' recover
```

恢复命令会把遗留的 `starting`/`running` session 标记为 `interrupted`，不会删除历史。
