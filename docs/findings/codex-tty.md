# Codex CLI TTY capability finding

日期：2026-09-09

## 已验证

- `agent-scope codex [args...]` 已接入与 Claude 相同的 node-pty/ConPTY
  interactive runner；source metadata 为 `codex-cli` / `codex-cli-tty`。
- fake PTY 回归覆盖启动 prompt、普通输入、工作输出、Codex ready prompt、turn
  completion、session finish、observer evidence 和多轮 title/status 持久化。
- Windows npm 安装的 `codex.cmd` Node shim 已通过 wrapper 实际启动
  `codex --no-alt-screen --version`；无需把 shim 路径硬编码进仓库。
- Codex 常见 `›` ready prompt 已纳入低置信度 PTY detector，并在观察到实际活动后
  生成 turn completed 候选；显式 AgentScope marker 仍具有更高置信度。
- `codex resume <id>` 的显式 conversation reference 会被保守记录；`resume --last`
  只记录 continuation request，不把不确定的最近会话强行合并。

## 有意不宣称

TTY 输出本身不能可靠提供 Codex 内部的 token usage、tool call、milestone、精确 ETA
或结构化事件。Dashboard 展示的是 AgentScope 根据 turn boundary、进程、Git、文件和
验证 observer 生成的实时投影。需要 provider-native JSONL 时，继续使用
`agent-scope run codex -- ...` structured adapter。

## 最终真实验收

2026-09-09，用户在真实 Codex CLI 会话中完成多轮 TTY 测试，并确认任务输入、原生
交互界面和 AgentScope Dashboard 监控均正常。至此 Codex TTY 的主要使用场景已通过
最终验收。

验收期间 Codex 输出过 `MCP client for codex_apps failed to start` 以及对
`https://chatgpt.com/backend-api/ps/mcp` 的 HTTP 请求错误。该连接属于 Codex 的
可选 `codex_apps` MCP/ChatGPT 后端，不是 AgentScope 的 adapter 或 TTY 错误；它不
阻止 Codex 主会话继续工作，也不影响 AgentScope session/turn/observer 记录。若需要
该 MCP 能力，应另行检查 Codex 登录状态、网络代理和 ChatGPT 后端可达性。
