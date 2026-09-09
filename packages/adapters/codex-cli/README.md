# Codex CLI adapter

本包负责 Codex CLI 的可执行文件检测、`codex exec --json --ephemeral` 启动、JSONL 增量解析和统一事件标准化。Codex-specific 字段只在本包内解析，不泄漏到 Core、Storage 或 Dashboard。

当前稳定映射：

- 每条 JSONL 记录都会生成脱敏的 `provider_event`，用于在 Dashboard 统计
  provider event family/phase；只保留类型、阶段、状态、退出码和 token 计数等安全标量。
- `thread.started` → `session_started`，只保留 provider thread id 作为可选 metadata。
- `turn.started` → `planning`，并保留对应的 native provider event。
- `item.started/completed(command_execution)` → `tool_call_started/finished` 和
  `command_started/finished`，只保留 item id、状态和退出码，不保留命令正文。
- `item.completed(agent_message)` → 脱敏后的 `agent_message` 摘要。
- `turn.completed.usage` → `usage_updated`，归一化 input/output/cache-read/reasoning/total
  token；Codex 当前没有可靠的 cost 字段，因此不会猜测费用。
- `turn.completed` → 终态候选；如果本轮出现非零命令退出码，adapter 会将最终状态归一化为 `failed`。

Codex JSONL 当前没有被验证为稳定的 provider-native milestone 或 dedicated file event，
因此这两项仍保持 `false`，分别回退到 AgentScope 的 progress/activity 和 filesystem observer。

`--json` 失败或非零进程退出时，调用方仍可结合 ProcessObserver、GitObserver、FileObserver 和 TestObserver 提供降级信号。真实 CLI smoke 和 TTY 行为不在 unit fixture 中伪造，证据记录在 `docs/findings/codex-cli.md`。
