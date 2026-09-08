# Process observer

观察 wrapper 启动的根进程，记录 pid、start/end、exit code 和 signal。observer 不采集
命令行或环境变量。默认只观察根进程；TTY wrapper 可以显式设置 `observeChildren: true`，
此时按平台进程表发现直接和传递子进程，并记录子进程的 pid、父 pid 和可用的可执行文件名。
子进程信息仅用于推断“工具/命令活动”，不会把命令行参数或环境变量写入证据。平台查询失败
时仍保留根进程生命周期观察，子进程视图降级为不可用。
