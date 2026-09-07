# CLI app

提供 `agent-scope start/run/sessions/show` 命令，并负责 wrapper 的用户入口与退出码透传。

## Quick start

```powershell
pnpm install
pnpm start
```

默认服务地址为 `http://127.0.0.1:8787`，Dashboard 地址为
`http://127.0.0.1:5173`，数据库位于 `.agentscope/agentscope.db`。命令以前台运行，
按 `Ctrl+C` 会同时关闭后端和 Dashboard。Clash 的 `7897` 是代理端口，不是 AgentScope
监听端口；如 CLI 需要联网代理，请在 CLI 进程环境中单独配置代理变量。

可用 `--host`、`--port`、`--database`、`--dashboard-port` 覆盖启动配置，也可以使用对应的
`AGENTSCOPE_HOST`、`AGENTSCOPE_PORT`、`AGENTSCOPE_DATABASE`、`AGENTSCOPE_DASHBOARD_PORT`
环境变量。追加 `--no-dashboard` 可只启动后端；这适合由其他进程托管 Dashboard 或运行
服务器端测试的场景。

使用真实 Claude Code CLI 时，AgentScope 只启动本地 `claude` 可执行文件，不直接请求
Anthropic 或其他 provider API：

```powershell
agent-scope run claude -- --bare -p "your prompt" --output-format stream-json --verbose
```

`--` 后的参数会原样传给 Claude CLI。stdout/stderr 会继续显示在当前终端，同时安全的
生命周期和工具调用摘要会写入 AgentScope SQLite。Claude CLI 使用的 endpoint、model 和
credential 由其自身环境决定。

需要完整使用 Claude Code 的 hooks、LSP、插件、memory 和 CLAUDE.md 自动发现时，不要
使用 --bare。如果 Claude 首次启动询问是否使用当前 ANTHROPIC_API_KEY，可以让 AgentScope
只自动确认这一条明确的 API key 提示。启动命令为：

agent-scope claude --agent-scope-accept-api-key

该选项不会把参数传给 Claude，也不会自动回答工具审批、slash 命令或其他交互提示；没有检测到
明确 API key 提示时不会写入任何内容。省略该选项则保持完全手动确认行为。
