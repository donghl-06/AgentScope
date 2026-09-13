# Worker capability matrix（V1）

更新时间：2026-09-13  
夹具：[`tests/fixtures/capabilities/worker-capability-matrix-v1.json`](../../tests/fixtures/capabilities/worker-capability-matrix-v1.json)

这份矩阵把 Claude Code、Codex CLI 和 Codex app-server 的能力按“实际观察到的版本”冻结下来。它不是对未来 CLI 的承诺：版本变化后必须重新执行本地探针、更新夹具并重新审查降级策略。未知能力保持 `unknown` 或 `unavailable`，不会被推断成支持。

## 当前版本与路径

| Provider / Adapter | 本机版本 | 主要探针 | 主要用途 |
| --- | --- | --- | --- |
| Claude / `claude-code` | 2.1.263 | `claude --help`、脱敏 stream-json fixture | 结构化任务、原生 usage/tool/command |
| Claude / `claude-code-tty` | 2.1.263 | PTY smoke、进程/文件/Git observer | 日常完整多轮终端体验 |
| Codex / `codex-cli` | 0.153.4 | `codex exec --help`、脱敏 JSONL fixture | 一次性结构化任务 |
| Codex / `codex-cli-tty` | 0.153.4 | PTY smoke、进程/文件/Git observer | 日常多轮终端体验 |
| Codex / `codex-app-server` | 0.153.4 | `codex app-server --help`、JSON-RPC fake/probe | 细粒度原生事件 |

## 解释规则

- `verified`：当前版本有公开界面并由本地探针或脱敏 fixture 验证。
- `observed`：在某些事件/路径中观察到，但不是每个任务都会发出。
- `available`：CLI 表面可用，但仍需要具体任务或 provider 才能产生数据。
- `conservative`：能力请求存在，但 AgentScope 没有安全的自动控制面，默认不放行。
- `unavailable` / `unsupported`：该路径没有稳定能力；使用记录中的 fallback。
- `unknown`：尚未审查，必须先补探针，不能据此执行危险动作。

矩阵中的前七个维度投影到 adapter 的 `AgentCapabilities`，用于 Progress、ETA 和 Dashboard 的真实降级。`permissionRequests`、`interrupts`、`tty`、`resume` 是控制/运行时维度，保留在矩阵中供策略和验收使用，不能当作 provider telemetry 已经存在。

## 安全与升级规则

1. `AgentAdapter.capabilities()` 仍是运行时的最小安全声明；矩阵 fixture 是版本化审查记录，不会在 CLI 更新后自动扩大能力。
2. 新版本若没有对应 profile，先按现有 adapter 的保守能力运行；只有完成探针、脱敏和审查后才更新 fixture。
3. 结构化路径缺少字段时显示 `Unavailable`，不从 TTY、日志或 prompt 猜 token、cost、milestone、工具参数或精确 ETA。
4. `conservative` 审批能力必须进入 `NEEDS_HUMAN`/`blocked` 路径，不能因为 provider 返回“可执行”就自动批准。
5. 每次矩阵变更都必须运行 parser 的 missing/new-field 测试、相关 adapter 测试、typecheck、lint 和全量测试。

## 已知边界

- Claude TTY 和 Codex TTY 的 native usage、tool lifecycle、milestone 仍不可见；它们通过 PTY、进程、文件和 Git observer 提供实时但推断性的进度。
- Codex app-server 适合细粒度 telemetry，不替代 TTY；没有审批 UI 时请求保守拒绝。
- 精确 cost 和 provider 未来 ETA 没有稳定公共字段，AgentScope 只展示 provider 实际报告的值或 evidence-based estimate。
