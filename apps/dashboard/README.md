# Dashboard app

React + Vite Dashboard：项目总览、session 列表、session detail、timeline 与 WebSocket
实时刷新体验。

## Local development

先在一个终端启动 AgentScope server：

```powershell
node ..\cli\bin\agent-scope.mjs start
```

再启动 Dashboard：

```powershell
pnpm --filter @agentscope/dashboard dev
```

浏览器打开 `http://localhost:5173`。开发服务器会把 `/api` 和 `/ws` 代理到
`127.0.0.1:8787`；生产部署时可通过 `VITE_API_BASE_URL` 指向 AgentScope server。
