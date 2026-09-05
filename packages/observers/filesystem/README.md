# Filesystem observer

在 workspace 边界内监听文件 create/modify/delete，并实施 ignore、debounce 和事件合并。

`FilesystemObserver` 只产生相对路径、变更类型和时间戳，不读取文件内容。默认忽略
`.git`、`.agentscope`、`node_modules`、构建产物、coverage 和缓存目录；`rootPath`
会被 resolve，越界路径会被丢弃。

启动时读取 workspace 根目录的 `.gitignore`，支持常用路径、`*`/`**`/`?` 通配和最后匹配的 `!` 否定规则。AgentScope 的默认硬忽略（`.git`、`.agentscope`、依赖和构建缓存）优先级更高，项目规则不能重新打开这些目录。
