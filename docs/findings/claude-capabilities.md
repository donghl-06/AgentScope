# Claude Code 交互能力矩阵（脱敏）

日期：2026-09-07  
CLI：Claude Code `2.1.261`  
配置：本机 Kimi-compatible Anthropic endpoint（不记录 endpoint、API key 或 prompt）

## 已确认的静态能力

| 能力 | 结果 | 证据/边界 |
| --- | --- | --- |
| 默认交互模式 | Available | `claude` 不带 `-p` 时进入交互会话 |
| 结构化打印模式 | Available | `-p/--print` + `--output-format text/json/stream-json` |
| 实时 stream | Available | `--output-format stream-json`，可组合 `--verbose` |
| 多轮续接 | Available | `--continue` 续接当前目录最近会话；`--resume <session-id>` 按 ID 续接 |
| 后台会话 | Available | `--bg/--background` 返回 session id，并支持 `attach/logs/stop/rm` |
| 参数透传 | Available | `--add-dir`、`--settings`、`--allowed-tools`、`--permission-mode` 等均由 CLI 暴露 |
| hook 事件输出 | Available | `--include-hook-events` 仅对 `--print --output-format=stream-json` 生效 |
| partial message 输出 | Available | `--include-partial-messages` 仅对 `--print` 生效 |
| 最小模式 | Available | `--bare` 明确跳过 hooks、LSP、插件同步、memory 和 CLAUDE.md 自动发现 |

## 需要真实 provider 才能确认的能力

- Kimi endpoint 下实际触发哪些 hook 生命周期事件（turn/tool/notification/stop）。
- `--resume` 与 `--continue` 的 session identity、工作目录边界和失败返回码。
- 交互式 TTY 中审批、多行输入、slash 命令和 Ctrl+C 的 provider-specific 行为。

这些项不能从 `--help` 推断。AgentScope 的 PTY runtime 不依赖 hooks；即使 hooks 不可用，
基础终端转发仍应保持可用。真实 provider 验证放到 Phase 3 的 disposable project 手工验收。

## AgentScope interactive wrapper smoke

在 Windows native、当前 Claude Code 安装下执行了不访问 API 的：

```text
AGENTSCOPE_DATABASE=:memory:
node apps/cli/bin/agent-scope.mjs claude --version
```

结果：原生 Claude 版本输出透传为 `2.1.261 (Claude Code)`，PTY 正常释放，wrapper 退出码为 `0`。
该 smoke 只证明 executable 解析、cwd/参数透传和正常收尾，不等同于真实 provider 多轮交互验收。

随后一次 Kimi-backed smoke 触发了 endpoint 的并发限制；中断后本机 Claude Code 自动更新留下了
未完成的 native 安装（`bin/claude.exe` 变成 postinstall 占位文件，旧 binary 被保留为带时间戳的
备份）。wrapper 现已在 spawn 前识别这种状态并给出可操作错误。继续真实 provider 验收前，必须先
在用户实际运行 Claude 的 PowerShell 中恢复安装，并确认 `claude --version` 成功。

本次已使用该时间戳备份完成可回滚恢复：占位文件被保留为 `claude.exe.failed-20260907-153933`，
native binary 和三个 npm shim 已恢复。随后 `claude --version` 以及
`agent-scope claude --version` 均返回 `2.1.261 (Claude Code)`、退出码 `0`。后续真实 provider
测试暂不自动重跑，避免再次触发并发限制或自动更新。

AgentScope interactive wrapper 支持可选的 `AGENTSCOPE_CLAUDE_EXECUTABLE` 环境变量，用于在
回归测试或 provider 切换期间固定一个已经验证的 Claude native binary；未设置时仍按 PATH 和
默认 npm 安装解析 `claude`。

## GLM 真实 provider 验收

2026-09-07 使用用户提供的 GLM Anthropic-compatible endpoint（不记录 endpoint、API key 或
prompt），通过已固定的 Claude Code `2.1.261` native binary 执行了两类真实验收：

1. 非交互 smoke：`--bare -p "Reply with OK only" --output-format stream-json --verbose`。
   模型返回 `OK`，最终 `is_error:false`，退出码为 `0`；AgentScope 数据库记录为
   `claude-code-tty / completed`。
2. 交互式 TTY 多轮：在同一个终端连续发送 `Reply with EXACTLY FIRST` 和
   `Reply with EXACTLY SECOND`，分别得到 `FIRST` 和 `SECOND`，随后使用 `/exit` 正常退出。
   数据库记录为 `claude-code-tty / completed`，事件包含 `session_started` 和
   `session_finished(reason=completed, exitCode=0)`。

过程中出现的 `unrecognized_model` 仅针对 Claude 的会话标题生成请求；主任务响应和退出状态
均成功，不构成此次验收失败。此前卡在 API key 确认界面的旧测试会话已按恢复规则标记为
`interrupted`，避免 Dashboard 保留错误的 `running` 状态。

## Windows VS Code Terminal 人工 smoke

2026-09-07 在 Windows VS Code PowerShell 中加载本地 GLM 配置，通过
`node apps/cli/bin/agent-scope.mjs claude --bare` 进行交互式验收。普通多轮输入、
Dashboard 同库联动、running 到 completed 的状态变化以及终端原生显示均通过；本次未执行
Ctrl+C 中断实验，因此当前仍不宣称交互式中断体验已完成。

随后在同一 Windows VS Code PowerShell 终端中执行了长任务 Ctrl+C 验收：第一次 Ctrl+C
中断当前动作但保留 Claude 交互会话，之后仍可继续提交任务；会话最终可正常退出。

随后完成终端 resize 人工验收：反复缩放 VS Code 终端时，Claude 界面正常重排，
没有乱码、残留字符或光标错位；输入仍可用，Dashboard 保持实时连接，session 没有重复或
404 数据。Windows 交互式终端的基础缩放行为通过。
