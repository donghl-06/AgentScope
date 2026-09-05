# Filesystem observer

在 workspace 边界内监听文件 create/modify/delete，并实施 ignore、debounce 和事件合并。

`FilesystemObserver` 只产生相对路径、变更类型和时间戳，不读取文件内容。默认忽略
`.git`、`.agentscope`、`node_modules`、构建产物、coverage 和缓存目录；`rootPath`
会被 resolve，越界路径会被丢弃。
