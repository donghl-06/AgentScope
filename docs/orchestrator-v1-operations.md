# AgentScope Orchestrator V1 运维与恢复指南

这份指南补充[SQLite 存储与迁移](storage-operations.md)，重点说明 V1 控制面、租约、通知和发布前检查。它
假定 AgentScope 在本机运行，不提供跨机器执行、远程 Worker 或自动化云端备份。

## 日常启动与诊断

在项目根目录设置固定数据库路径后只启动一个 Server：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start
```

检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/api/diagnostics
```

`healthz.status` 为 `ok` 只代表 Server 已监听；Dashboard 的 `Live updates connected` 还需要页面能够访问
同一个 Server。出现 `EADDRINUSE` 时先定位并停止旧 Server，不能通过修改数据库路径绕过端口冲突。

## V0→V1 数据升级

打开 V0 数据库时，storage 会自动顺序应用 `0006` 至 `0011` 的增量 migration。升级前必须停止写入并备份
`agentscope.db`、`-wal`、`-shm`；升级过程不要求用户执行 SQL。升级后检查：

1. 原有 Session、Turn、Evidence 可在 Dashboard 打开；
2. 原有 Goal（若有）仍能读取其 Task、Attempt 和 Verification；
3. `/api/goals/page` 默认不返回归档 Goal，`includeArchived=true` 可以读回；
4. 归档/恢复写入审计 Event，重复请求不产生重复副作用；
5. `/api/diagnostics` 没有持续 busy、重复事件或 WebSocket 发送失败。

失败时不要删除 migration 记录或手工反向修改 schema，按存储指南的隔离恢复流程操作。

## 控制面安全规则

- 数据库约束、Goal lease 和进程内互斥共同保证一个活动 Goal；前端禁用按钮不是安全边界。
- Pause、Continue、Resume、Retry、Abort 和 Instruction 使用持久化控制记录或安全边界；重复请求应返回相同结果或
  明确冲突，而不是创建第二个 Attempt。
- Instruction 在运行中先保持 `PENDING`，下一个安全边界才可能变成 `APPLIED`；历史内容不原地覆盖。
- Roadmap 编辑只作用于未来 Task，并创建新的 immutable revision；“删除”未来 Task 表示可审计 `SKIPPED`。
- 风险动作必须有精确的 action/scope/revision Approval；没有审批或 Provider 能力不足时进入人工处理。
- 重启后无法证明旧 Provider 进程已经停止时，Goal 进入 `NEEDS_HUMAN`；确认外部进程状态后再 Continue/Resume。

## 恢复操作

停止后重启 Server，再运行：

```powershell
node .\apps\cli\bin\agent-scope.mjs recover
```

恢复命令会把 stale 的 queued/running/waiting Turn 收敛为 `interrupted`，保留明确 blocked 的 Turn，并记录有界
recovery evidence。Orchestrator Goal 的不确定 Attempt 不会自动复制启动。完成恢复后在 Dashboard 检查：

- Session/Goal 状态是否与外部进程实际状态一致；
- 是否只有一个活动 lease/Attempt；
- Timeline/Event 的 seq 是否连续；
- Pending Instruction、Approval 和 Notification 是否仍在；
- 再执行 Continue、Resume 或 Abort，而不是直接重复运行原始命令。

## 归档与清理

Goal `Archive` 适合整理已暂停、需人工或终态历史，保留全部证据并可 `Restore`；活动 Goal 永远不能归档。
Session `Hide` 适合暂时从列表移除，`Delete` 只适合确认不再需要的终态数据。删除前先确认不是用于 ETA 基线或
发布验收的唯一证据；删除后无法从数据库恢复，只能从备份还原整个数据库。

## 通知权限与跨进程广播

Orchestrator notification 写入 SQLite 后由 Server 的 live hub 广播到 Dashboard；独立 CLI/WSL2 进程不需要共享
内存。Dashboard 重连时通过 HTTP 快照和 cursor catch-up 恢复。浏览器通知是可选层：必须由用户在页面启用并授予
权限，拒绝权限不影响事件持久化。若通知重复，先检查 eventKey 和数据库是否被两个 Server 同时消费。

## Provider 与密钥运维

Provider 环境变量只在启动该 Provider 的终端加载，AgentScope 不代管账号登录。使用 `.env.*` 私密文件时确认它们
在 `.gitignore` 中；只检查变量是否存在，不回显 key。Kimi/GLM 等兼容 endpoint 出现并发限制时等待后再重试，
不要并行发起相同账户的真实任务。真实 Provider 失败应保留失败分类和 evidence，不将认证、权限或网络错误标作完成。

## 发布前检查

至少运行：

```powershell
pnpm format:check
pnpm fixtures:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

完整门禁使用 `pnpm release:check`。真实 Provider、浏览器绘制、多小时容量和 macOS 行为不属于本地自动门禁，
必须在发布记录中明确写成已验证、保守支持或未执行。
