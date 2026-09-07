# `@agentscope/terminal`

V1 的 provider-neutral 终端生命周期抽象。它保留 PTY 原始输出，不把 ANSI 控制序列转换成
AgentScope 自己的聊天界面，供后续 Claude/Codex 交互式 wrapper 复用。

当前实现包含：

- `NodePtyDriver`：基于 `node-pty@1.1.0` 的 Windows ConPTY / Unix PTY 适配器；
- `TerminalSession`：统一 spawn、输入、resize、Ctrl+C、退出和重复 cleanup 生命周期；
- 结构化的 `TerminalExit`、`TerminalDimensions` 和 `TerminalState` 类型。

原始终端 chunk 只在内存中通过 `onData` 转发，不由本包写入数据库。环境 allow-list、输出
backpressure、Unicode 分片缓冲、进程树清理和 CLI wrapper 将在后续 Phase 2/3 完成。

## 原生依赖安装

`node-pty` 需要执行原生安装脚本。workspace 的 `pnpm-workspace.yaml` 只显式允许这一项，
不应把所有依赖脚本一并放开。Windows 和 WSL2 的隔离安装证据见
`docs/findings/pty-driver.md`。
