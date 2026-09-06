# Dashboard app

React + Vite Dashboard：项目总览、session 列表、session detail、timeline 与 WebSocket
实时刷新体验。

## Local development

推荐由 CLI 一条命令同时启动 server 和 Dashboard：

```powershell
node ..\cli\bin\agent-scope.mjs start
```

开发时也可以只启动 Dashboard（前提是已有 server 运行）：

```powershell
pnpm --filter @agentscope/dashboard dev
```

浏览器打开 `http://localhost:5173`。开发服务器会把 `/api` 和 `/ws` 代理到
`AGENTSCOPE_SERVER_URL`（其次是 `VITE_API_BASE_URL`，再其次是
`http://127.0.0.1:${AGENTSCOPE_PORT}`，默认 `8787`）。生产部署时可通过
`VITE_API_BASE_URL` 指向 AgentScope server。
