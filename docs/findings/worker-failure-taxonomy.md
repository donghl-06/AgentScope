# Worker Result 与失败分类（V1）

更新时间：2026-09-13  
对应计划：`orchestrator-v1-implementation-plan.md` Step 10.2

## 目的

Claude Code、Codex CLI 和 Codex app-server 的进程边界不同，但 Orchestrator 必须对它们使用同一套结果语义。Worker 结果现在可以携带一个安全的 `failure` 对象，而不是把 Provider 的原始 stderr、提示词、环境变量或 API 响应写进数据库。

## 分类

| code | 含义 | 是否自动重试 | 默认控制结果 |
| --- | --- | --- | --- |
| `provider_exit` | Provider 在可验证完成前退出 | 否 | `FAILED` |
| `auth` | 登录、API key 或身份验证失败 | 否 | `NEEDS_HUMAN` |
| `rate_limit` | 速率、并发或容量限制 | 是（由后续退避策略控制） | `FAILED` |
| `network` | 连接、TLS、DNS 或超时失败 | 是（由后续退避策略控制） | `FAILED` |
| `permission` | 权限、审批或执行策略不允许 | 否 | `NEEDS_HUMAN` |
| `invalid_output` | 结构化输出无法解析或不完整 | 是（仅在没有有效终端结果时） | `FAILED` |
| `user_interrupt` | 用户或宿主机中断 | 否 | `INTERRUPTED` / `NEEDS_HUMAN` |
| `spawn_error` | Provider 进程无法启动 | 否 | `NEEDS_HUMAN` |
| `unknown` | 无法安全归类的失败 | 否 | `FAILED` |

分类顺序会先识别中断、并发限制和网络错误，再识别认证/权限；这样兼容 endpoint 用 HTTP 403 表示临时并发限制的情况。`summary` 只包含固定的可读文案，`diagnosticRef` 只包含脱敏后的 provider、分类和退出码，不是原始日志索引。

## 可恢复 malformed 输出

Provider 偶尔可能在有效 JSONL/JSON-RPC 记录前输出一行无法解析的文本。Adapter 会记录一个 `error` 事件（`code=invalid_output`），但只要后续出现有效的终端完成记录，就保留完成状态；否则 Adapter 以失败终止。Core reducer 对这个特定 code 也保持非终态，使事件回放与实时 projection 一致。

## 人工介入边界

认证、权限和启动失败不会被标记为成功，也不会自动重试。Orchestrator 会把 Attempt 置为 `NEEDS_HUMAN`，并保留验证失败与安全摘要，等待用户修复环境或明确后续动作。原始 Provider 输出仍只通过短暂 stderr 转发给当前终端，不进入持久化结果。

## 验证

- 三个 Adapter 的 malformed-output、完成、失败和中断回归测试。
- Worker classifier 的分类、retryable 标志和摘要脱敏测试。
- Core reducer 的 malformed-output 回放一致性测试。
- CLI provider-runner、Orchestrator/CLI lint 与 typecheck。
