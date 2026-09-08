# Claude Code adapter

Claude Code CLI 检测、启动、structured output 解析、标准化和 fallback。Claude-specific 类型不得泄漏到 Core。

当前已实现脱敏 JSONL parser：支持 `system/init`、thinking-token 增量、assistant 文本/工具调用、
tool result、stream phase 和 `result` 生命周期映射；增量 decoder 可处理拆分 chunk 与 CRLF，
未知记录会被安全计数，malformed JSON 不会使 parser 抛出异常。

结构化路径会归一化 provider session/model/CLI 能力目录、input/output/cache/thinking/reasoning
token、cost、API/TTFT/首帧/队列 timing、native event phase、工具调用成功/失败/耗时，以及
显式 milestone。Parser 只保留低敏摘要、计数和工具名称，不保存 prompt、命令内容、完整工具输出、
secret 或完整 provider 输出。普通 PTY 多轮仍由 interactive runner 负责；PTY 本身不能提供 Claude
的完整 JSONL usage frame，使用者需要 provider-native telemetry 时应走 structured `run claude`。

推荐的细粒度命令形态：

```powershell
node .\apps\cli\bin\agent-scope.mjs run claude -- `
  --print --output-format stream-json --verbose `
  --include-hook-events --include-partial-messages `
  -p "your task"
```

真正启动进程和把归一化事件写入 Storage 仍由 CLI wrapper 生命周期步骤接入。
