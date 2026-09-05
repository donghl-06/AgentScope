# Observer evidence fusion

本包提供 workspace observer 与 adapter 原生事件之间的最小证据裁决层。它不执行命令、不读取文件内容、不写数据库，也不改变统一事件协议；调用方可以在持久化前使用 ledger 选择同一逻辑信号中最可信的一条证据。

优先级固定为：

1. `native`：adapter 的稳定 structured event。
2. `process` / `test_observer`：wrapper 进程与已知验证命令的客观观察。
3. `git` / `filesystem`：workspace 状态变化的推断信号。
4. `agent`：Agent 自报或低可信 message。

同一 `key` 只保留一条证据。相同来源和优先级下按 confidence、timestamp、id 做确定性裁决，确保 replay 不依赖 Map 插入顺序。
