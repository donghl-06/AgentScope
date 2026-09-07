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
