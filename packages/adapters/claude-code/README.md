# Claude Code adapter

Claude Code CLI 检测、启动、structured output 解析、标准化和 fallback。Claude-specific 类型不得泄漏到 Core。

当前已实现脱敏 JSONL parser：支持 `system/init`、assistant 文本/工具调用、tool result 和
`result` 生命周期映射；增量 decoder 可处理拆分 chunk 与 CRLF，未知记录会被安全忽略，
malformed JSON 不会使 parser 抛出异常。
Parser 只保留低敏摘要和工具名称，不保存 prompt、命令内容或完整 provider 输出。真正启动
进程和把事件写入 Storage 仍由 CLI wrapper 生命周期步骤接入。
