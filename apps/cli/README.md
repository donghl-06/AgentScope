# CLI app

提供 `agent-scope start/run/sessions/show` 命令，并负责 wrapper 的用户入口与退出码透传。

## Quick start

```powershell
pnpm install
pnpm --filter @agentscope/cli exec agent-scope start
```

默认服务地址为 `http://127.0.0.1:8787`，数据库位于 `.agentscope/agentscope.db`。
服务以前台运行，按 `Ctrl+C` 关闭。Clash 的 `7897` 是代理端口，不是 AgentScope
监听端口；如 CLI 需要联网代理，请在 CLI 进程环境中单独配置代理变量。

可用 `--host`、`--port`、`--database` 覆盖启动配置，也可以使用对应的
`AGENTSCOPE_HOST`、`AGENTSCOPE_PORT`、`AGENTSCOPE_DATABASE` 环境变量。
