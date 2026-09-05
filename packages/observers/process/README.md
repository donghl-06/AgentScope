# Process observer

观察 wrapper 启动的根进程，记录 pid、start/end、exit code 和 signal。observer 不枚举
不相关进程，也不采集命令行或环境变量；子进程树的扩展由上层 wrapper 显式提供。默认
轮询只把明确的 `ESRCH` 视为进程退出，权限或平台不确定时保持 `unknown`，避免误报。
