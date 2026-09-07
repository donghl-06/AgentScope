# PTY 驱动 Spike Findings

日期：2026-09-07  
环境：Windows native、Node.js v24.14.1、pnpm 11.19.0；WSL2 Node.js v22.14.0、pnpm 10.33.0；
隔离 spike 使用对应环境安装 `node-pty@1.1.0`

## 当前结论

`node-pty` 已锁定为 V1 透明交互终端驱动并进入 AgentScope 主 workspace。Windows ConPTY
和 WSL2/Linux 基线均可行；长时间资源、长时间 backpressure 和生产故障恢复仍需 runtime 测试。

官方参考：<https://github.com/microsoft/node-pty>

## 测试矩阵

| 场景 | 结果 | 备注 |
| --- | --- | --- |
| Windows 安装 | Pass with explicit build approval | pnpm 默认阻止原生 build script；批准后 prebuild/postinstall 成功 |
| ANSI/光标输出 | Pass | fake cmd 输出 ConPTY 初始化和光标控制序列 |
| 字符输入 | Pass | `write()` 注入命令，fake cmd 返回 `PTY_INPUT` |
| 窗口 resize | Pass | `resize(100, 30)` 无异常，并收到 resize 控制序列 |
| 正常退出 | Pass | fake cmd 返回 exit code 0 |
| Ctrl+C | Pass | 子进程返回 `-1073741510`，对应 Windows 控制台中断 |
| 已退出 PTY 重复 kill | Needs wrapper guard | 触发 `AttachConsole failed`，必须由生命周期状态机避免 |
| WSL2/Linux 安装 | Pass | WSL2 Node 22 + pnpm 10 隔离安装成功 |
| WSL2/Linux 输入/输出/resize | Pass | fake bash 返回 `READY`、`ECHO:PTY_INPUT`，resize 无异常 |
| WSL2/Linux Ctrl+C | Pass | fake bash 返回 exit code 130 |
| Unicode | Pass | terminal package native smoke 收到 `READY:你好` |
| 长输出/backpressure | Pass (bounded) | output buffer 单元测试验证有界丢弃和慢读取方；多小时压力仍待测 |

## 安装观察

`node-pty@1.1.0` 在本机 Node 24/x64 能完成安装，但 pnpm 的 build-script approval 必须在
开发/CI/用户安装策略中明确。不能把“自动允许所有依赖脚本”作为默认方案；应只批准已审计的
native dependency，并在 lockfile、安装文档和依赖审计中留下证据。

## 下一步

1. 用 fake TUI 和 native PTY 继续覆盖输入、输出、resize、Ctrl+C、重复 cleanup 和 child crash。
2. 增加长时间输出/backpressure、clean-install 和跨平台 CI 门禁。
3. 通过自动化门禁后，再在可信 disposable project 中进行一次真实 Claude 交互验收。
