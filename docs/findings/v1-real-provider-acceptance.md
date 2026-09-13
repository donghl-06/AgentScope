# V1 真实 Provider 安全验收

**日期：** 2026-09-13  
**范围：** Windows 本机、临时工作区、临时 AgentScope SQLite 数据库  
**原则：** 不使用项目工作区写入，不提交、不推送、不安装依赖；Provider 凭据只从本机已有的 gitignored 环境配置读取。

## 验收结论

Claude Code 和 Codex CLI 均已通过 V1 的真实 Provider 基本闭环。两次测试都由
`agent-scope run` 创建独立的 AgentScope session，并在 Provider 进程结束后写入终态、事件和
observer evidence。Claude 的真实结构化流包含工具/命令/思考/文本等细粒度事件；Codex 的
JSON 流包含 thread/turn/item 生命周期与命令事件。未由 Provider 稳定提供的 file events 和
milestones 仍按 capability 显示为 unavailable，不进行推测。

## Claude Code

### 写入 + 验证

- **AgentScope session：** `4c9766fa-5078-47e7-92bc-43f34ebadc66`
- **adapter/status：** `claude-code` / `completed`
- **工作区：** 隔离临时目录（不在仓库内）
- **任务：** 创建 `verification-artifact.txt`，使用只读命令逐字节验证
  `REAL_CLAUDE_WRITE_OK`
- **Provider 结果：** `REAL_CLAUDE_WRITE_OK`，4 turns，`is_error=false`
- **AgentScope 记录：** 3360 events、5 observer evidence
- **能力：** structured events、tool calls、command events、token usage、session info、
  milestones；file events 由当前 observer 配置标记为 unavailable

### 验证失败 + 修复

- **AgentScope session：** `2bdb44a2-0a90-4fe7-ad8b-e370b40c4a1e`
- **adapter/status：** `claude-code` / `completed`
- **任务：** 先写入 `WRONG_VALUE` 并让精确验证失败，再修复为
  `REAL_CLAUDE_REPAIR_OK` 并重新验证通过
- **Provider 结果：** 明确记录首轮 `FAIL`、修复动作和二次 `PASS`，最终输出
  `REAL_CLAUDE_REPAIR_OK`；5 turns，`is_error=false`
- **AgentScope 记录：** 5519 events、6 observer evidence
- **安全检查：** 仅操作临时工作区，未触碰仓库或工作区之外内容

## Codex CLI

- **AgentScope session：** `5d47340d-367f-4ed1-b618-7d1a0d7b6c3e`
- **Provider thread：** `01a0998d-4bfc-7fd1-815e-a9e76201648d`
- **adapter/status：** `codex-cli` / `completed`
- **任务：** 读取 `package.json`、`ROADMAP.md`，检查 Git 状态并只做总结，最后输出
  `REAL_CODEX_READONLY_OK`
- **Provider 结果：** `thread.started`、`turn.started`、command item 生命周期和最终
  `REAL_CODEX_READONLY_OK` 均收到；退出码 0
- **AgentScope 记录：** 29 events、11 observer evidence
- **能力：** structured events、tool calls、command events、token usage、session info；
  file events 和 milestones 当前标记为 unavailable
- **运行前提：** Codex CLI 需要 `CODEX_HOME` 指向本机已有的 Codex 配置目录，并且该目录
  允许写入运行时 state；否则 CLI 会在初始化 app-server client 前报“无法访问/readonly
  database”。这属于本机运行环境前提，不是 AgentScope 会话状态错误。

## 数据与隐私核对

- 三次验收均使用临时数据库，未污染仓库的历史数据库和 Dashboard 数据。
- 文档只记录 session/thread 标识、状态、事件数量和能力矩阵，不记录 API key、原始 prompt、
  token 内容或原始 stdout。
- 真实 Provider 返回的 cost/usage 只作为本次诊断结果使用，未写入仓库；后续 UI 仅在字段
  稳定、可验证时展示具体值。

## 后续边界

本验收证明真实 Provider 的启动、结构化事件归一化、observer 采集、终态收尾和错误修复链路
可用；它不宣称 TTY 模式能够提供 Provider 原生 milestones、精确 ETA 或完整 file event。
这些字段继续遵循 capability-driven 的 `Unavailable` 语义。下一阶段使用合成历史校准
Progress/ETA，再运行性能和长时稳定性基线。
