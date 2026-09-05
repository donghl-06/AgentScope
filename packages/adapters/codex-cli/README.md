# Codex CLI adapter

本包负责 Codex CLI 的可执行文件检测、`codex exec --json --ephemeral` 启动、JSONL 增量解析和统一事件标准化。Codex-specific 字段只在本包内解析，不泄漏到 Core、Storage 或 Dashboard。

当前稳定映射：

- `thread.started` → `session_started`，只保留 provider thread id 作为可选 metadata。
- `turn.started` → `planning`。
- `item.started/completed(command_execution)` → `command_started/command_finished`，不保留命令正文。
- `item.completed(agent_message)` → 脱敏后的 `agent_message` 摘要。
- `turn.completed` → 终态候选；如果本轮出现非零命令退出码，adapter 会将最终状态归一化为 `failed`。

`--json` 失败或非零进程退出时，调用方仍可结合 ProcessObserver、GitObserver、FileObserver 和 TestObserver 提供降级信号。真实 CLI smoke 和 TTY 行为不在 unit fixture 中伪造，证据记录在 `docs/findings/codex-cli.md`。
