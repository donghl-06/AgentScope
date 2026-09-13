# AgentScope SQLite 存储与迁移

AgentScope 的 Server、CLI、Orchestrator 和 Dashboard 共享一个本地 SQLite 数据库。默认路径为
`.agentscope/agentscope.db`；也可以通过 `AGENTSCOPE_DATABASE` 或 CLI 的 `--database`/`--db` 参数指定
绝对路径。所有进程必须使用同一个路径，才能看到同一组 Session、Goal、Task 和实时事件。

## Migration 规则

`@agentscope/storage` 在打开数据库时按顺序应用尚未执行的 migration。当前版本的 migration 为：

| Migration | 主要内容 |
| --- | --- |
| `0000_initial` | Projects、Sessions、Events、Milestones、ETA snapshots |
| `0001_session_status_updated_index` | Session 状态/更新时间索引 |
| `0002_observer_evidence` | Process、Workspace、known-command observer evidence |
| `0003_turns` | Session 所属的 Turn 投影 |
| `0004_observer_evidence_turn` | Observer evidence 的可选 Turn 关联 |
| `0005_session_visibility` | Session `hidden_at` 字段和可见性索引 |
| `0006_orchestrator` | Goal、Task、Attempt、Verification、Orchestrator Event 及索引 |
| `0007_orchestrator_single_active_goal` | 数据库级单活动 Goal 部分索引 |
| `0008_orchestrator_v1_control` | revision、归档、Instruction、Roadmap、Memory、Approval、Lease、Metric、Notification |
| `0009_orchestrator_commands` | 幂等控制命令及结果/错误记录 |
| `0010_instruction_source` | Instruction 来源（user/system/planner） |
| `0011_observer_evidence_attempt` | Observer evidence 的可选 Attempt 关联 |

迁移只向前执行：

- 不删除或修改 `_agentscope_migrations` 中的记录；
- 不重命名或编辑已经应用的 migration 文件；
- 需要变更 schema 时追加新的 migration；
- 应用不会自动降级，也不会把新数据库反向转换成旧 schema；
- 空数据库和已有 V0 数据库都由 storage 包自动迁移，无需用户手工执行 SQL。

升级前建议先完成[备份流程](#升级前备份)，再启动新版本 Server。升级后通过 `/healthz`、Session 列表和一个
Goal 详情确认读取正常。

## Session 清理语义

Dashboard 的 `Hide` 是可恢复的软隐藏：写入 `sessions.hidden_at`，默认 Session 列表和概览计数不再显示，
但保留 Session、Turn、Event、Milestone、ETA 和 observer evidence。勾选 `Show hidden` 后可以 Restore，
或者对已经结束的 Session 执行 `Delete`。

`Delete` 是数据库级不可逆删除，依靠外键级联删除该 Session 的 Turn、Event、Milestone、ETA snapshot 和
observer evidence。正在运行或刚启动的 Session 会由后端以 HTTP 409 拒绝，Dashboard 也不会显示删除按钮。
隐藏的已完成 Session 仍可参与历史 ETA 基线；永久删除后不再参与。

## Goal 归档语义

Goal 的 `Archive` 与 Session 的 `Delete` 不同：只允许 PAUSED、NEEDS_HUMAN 或终态 Goal 归档，活动 Goal 会
被拒绝；归档不删除 Task、Attempt、Verification、Event 或关联 Session。默认 Goal 历史隐藏归档项，勾选
`Include archived` 后可以 `Restore`。归档和恢复在同一事务中写入 Goal 与 `goal.archived`/
`goal.unarchived` 审计事件，重复调用是幂等的。

## 升级前备份

1. 停止前台 Server，以及所有可能写入该数据库的 CLI/Provider 进程。
2. 将数据库文件和同目录下（若存在）的 `-wal`、`-shm` 一起复制到带时间戳的备份目录；三个文件必须来自
   同一停止时刻。
3. 在备份旁记录 AgentScope commit、Node 版本、数据库绝对路径和执行目的。
4. 重启后访问 `/healthz`，运行 `pnpm test` 和对应的人工 smoke，再把备份作为唯一副本。

PowerShell 示例（请在项目根目录执行；示例不会覆盖已有备份目录）：

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$source = (Resolve-Path '.agentscope/agentscope.db').Path
$backup = Join-Path (Get-Location) ('.agentscope/backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath $source -Destination $backup
foreach ($suffix in @('-wal', '-shm')) {
  $sidecar = $source + $suffix
  if (Test-Path -LiteralPath $sidecar) {
    Copy-Item -LiteralPath $sidecar -Destination $backup
  }
}
```

如果 `agentscope.db` 不存在，说明当前还没有运行过需要持久化的本地实例；不要用空文件替代 SQLite 数据库。

## 恢复与回滚

1. 停止 AgentScope，并把当前数据库目录保留为隔离/检疫副本，不要直接覆盖。
2. 将备份的 `agentscope.db` 与对应 `-wal`、`-shm` 一起恢复到新的目录。
3. 用创建该备份的确切 commit 启动，并临时设置 `AGENTSCOPE_DATABASE` 指向恢复副本；如果新版本已经应用了
   migration，先在隔离副本上验证，不要反向编辑 migration。
4. 检查 `/healthz`、Session 列表、一个 Session 的 Timeline/Evidence，以及一个 Goal 的 Event/Verification。
5. 只有确认历史完整后，才把恢复路径用于 Resume 或 Provider 工作；保留检疫副本直到验收结束。

回滚是文件级恢复，不是反向 migration。若数据库损坏或 schema 版本不明，停止写入并保留所有副本，不能尝试
删除 `_agentscope_migrations` 或手工修改表结构来“修复”。

## 锁、租约与损坏排查

- 一个数据库路径只允许一个 AgentScope Server；多个 Server 会造成端口、SQLite busy 或 Goal lease 冲突。
- Server 使用 WAL 和有界 SQLite busy timeout。持续出现 `database is busy` 时，先停止重复进程和写入者，再重试。
- Goal lease 的过期由 Orchestrator 的恢复流程处理；未知外部 Worker 状态时进入 `NEEDS_HUMAN`，不会盲目启动第二个
  Attempt。不要直接删除 `goal_run_leases` 行绕过安全检查。
- 不要在 Provider 仍写入时复制、移动或编辑数据库；先停止写入者，再备份三个 SQLite 文件。
- 可用以下命令查看当前 Server 是否响应：

  ```powershell
  Invoke-RestMethod http://127.0.0.1:8787/healthz
  Invoke-RestMethod http://127.0.0.1:8787/api/diagnostics
  ```

- Dashboard 显示空数据或 `ECONNREFUSED` 时，先确认它的 Vite 代理和 Server 使用同一端口、同一数据库路径；不要
  通过切换到另一数据库掩盖问题。

## 日志、通知与隐私边界

原始 Provider 输出默认不落库。数据库仍可能包含工作区路径、Git 分支、事件摘要和 observer 元数据，应按本地
开发数据保护。API key、Bearer token、`.env` 内容和命令行 secret 不应进入 Goal、Instruction、日志、截图或 Git。

浏览器通知只在用户授予权限且 Dashboard 中启用后发送；权限被拒绝或浏览器不支持时，任务状态和数据库记录仍然
正常工作。通知采用持久化 eventKey 去重，重连不会重复弹出同一状态。
