# Git observer

识别 repo、branch、HEAD、dirty baseline 与 session 期间新增修改。实现使用 Git 的
machine-readable `status --porcelain=v1 -z`，不解析人类化输出，也不读取 diff 内容。

非仓库、Git 不可用和命令失败会返回 `isRepository: false` 或带 `reason` 的快照，不会
阻塞 session。baseline 是 session 开始时的只读快照，`changesSinceBaseline()` 只返回
路径级 added/modified/deleted/renamed 与 branch/head 变化。
