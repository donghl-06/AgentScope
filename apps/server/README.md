# Server app

HTTP API、WebSocket、服务生命周期和各核心 package 的组合入口。不得包含 Agent-specific 解析逻辑。

`startServer` 负责打开并迁移 SQLite、启动 Fastify，并以幂等方式关闭 HTTP/WebSocket 与数据库资源。端口、host 和数据库路径由 CLI/调用方显式提供。
