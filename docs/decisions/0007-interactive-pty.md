# ADR-0007：交互式 TTY 采用透明 PTY，并以 node-pty 作为首选 spike 候选

状态：Accepted for V1 implementation / 已完成 Windows 与 WSL2 隔离 spike，尚未接入生产依赖  
日期：2026-09-07

## 背景

V1 需要让用户在 AgentScope 管理的终端中像平常一样运行 Claude Code，并在同一个长期
session 中进行多轮输入。V0 的 `-p --output-format stream-json` 路径不提供完整的原生
交互式 TUI，因此需要透明的 PTY/ConPTY 层。

AgentScope 的 PTY 层必须负责终端保真度，不应把 ANSI 输出改写成自己的聊天界面。任务语义
由 turn coordinator、observer 和可选 hooks 另行产生；hooks 失效不能让终端失去可用性。

## 决策

1. V1 采用透明 PTY 架构，不实现替代 Claude Code 的聊天 UI。
2. 首选候选为 Microsoft `node-pty` `1.1.0`：其官方项目支持 Linux、macOS 和 Windows，
   Windows 使用 ConPTY，Node API 可提供 spawn、write、resize、onData 和 onExit。
3. 驱动选择锁定为 `node-pty`，但在 Windows 和 WSL2 的清理、resize、Unicode、Ctrl+C、长输出
   和 clean-install 回归全部通过前，不把依赖加入主 workspace 的生产路径。
4. 生产 wrapper 必须以状态机保护 cleanup：只有 child/PTY 仍然存活时才发送 kill；已经收到
   exit 的 PTY 不得无条件再次 kill。
5. `agent-scope run claude -- -p ...` 结构化路径继续保留，作为 CI、自动化和 PTY 不可用时的
   回退路径。

## 候选比较

| 候选 | 结论 | 原因 |
| --- | --- | --- |
| `node-pty` | 首选 spike 候选 | 官方维护、Windows ConPTY + Unix PTY、Node API 直接适合 wrapper；需要原生构建和平台 smoke |
| 纯 `child_process` stdin/stdout | 不适合交互 V1 | 无法可靠提供原生 TTY、光标控制、resize 和完整审批界面 |
| AgentScope 自建聊天 UI | 明确排除 | 会改变 Claude Code 使用体验，且不能自然保留原生 slash/approval/resume 行为 |
| 未验证的第三方 PTY fork | 暂不采用 | 需要额外验证维护状态、原生二进制、许可证和 Windows/WSL2 行为 |

## Windows spike 证据

在隔离临时目录安装 `node-pty@1.1.0`，使用当前 Windows Node `v24.14.1` 和 x64 环境：

- pnpm 安装成功；首次安装默认阻止 build scripts，显式批准后 prebuild/postinstall 成功，
  ConPTY DLL 被正确放置。
- fake `cmd.exe` 产生了 ANSI 初始化、光标、窗口标题和 `PTY_OK` 输出，退出码为 `0`。
- 使用 `write()` 注入命令并使用 `resize(100, 30)`，输入结果和退出码均正确。
- 向运行中的 fake Node 进程写入 ETX/Ctrl+C 后，进程返回 Windows
  `STATUS_CONTROL_C_EXIT`（`-1073741510`），证明中断可到达子进程。
- 在子进程已经退出后无条件调用 `kill()` 会触发 node-pty 的 `AttachConsole failed` 清理错误；
  这是 wrapper cleanup 状态机必须覆盖的边界，不代表正常 spawn/output 失败。

## WSL2 spike 证据

在隔离的 Linux 临时目录安装 `node-pty@1.1.0`，使用 WSL2 kernel、Node `v22.14.0` 和 pnpm
`10.33.0`：

- fake `bash` 交互程序成功输出 `READY`，通过 `write()` 收到输入并返回 `ECHO:PTY_INPUT`。
- `resize(100, 30)` 调用成功，进程正常退出码为 `0`。
- 向运行中的 fake `bash` 写入 ETX/Ctrl+C 后，进程以退出码 `130` 结束。
- WSL2 与 Windows 的基础 spawn、输入、输出、resize 和中断行为一致；长输出/backpressure、
  Unicode 和重复 cleanup 仍由 runtime 自动化测试覆盖。

## 后果

正面影响：可以保留 Claude Code 原生体验，并把 PTY 层与 provider 解析、turn 识别解耦。

代价和风险：需要原生模块安装、Windows ConPTY 与 Linux PTY 两套 smoke；Node/平台升级可能
影响预编译包；PTY 原始输出可能包含敏感内容，因此默认只实时转发、不持久化完整 transcript。

## 进入生产实现前的门禁

- WSL2/Linux 同等 spawn、输入、resize、Ctrl+C 和 Unicode smoke。
- Windows/WSL2 clean-install 和 build-script 策略写入安装文档。
- PTY 资源释放、重复 cleanup、child crash 和 wrapper abrupt exit 回归通过。
- 至少一个 fake interactive CLI 的输入边界与 turn coordinator fixture。
- 明确用户手工验收：原生 Claude UI、审批、多行输入、resize 和 Ctrl+C。
