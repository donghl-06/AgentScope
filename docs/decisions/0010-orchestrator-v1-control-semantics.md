# ADR 0010：Orchestrator V1 控制与恢复语义

- 状态：Accepted for V1 planning
- 日期：2026-09-13
- 范围：`@agentscope/orchestrator`、`@agentscope/storage`、Server、CLI、Dashboard
- 关联规格：`agentscope_orchestrator_codex_spec.md` 第 2、13、15、17、21 节；
  `docs/orchestrator-v1-implementation-plan.md`

## 背景

Orchestrator V0 已经可以自动执行单个 Goal 的串行 Task，但 V1 要允许用户在长期运行过程中查看历史、补充指令、
编辑未来路线图、暂停/恢复/重试以及处理风险审批。这些动作会改变后续调度，因此必须先冻结状态迁移、边界、审计和
并发语义，避免“恢复即重复执行”“编辑即完成”或“用户指令被下一次规划覆盖”。

本文是 V1 实施时的判定依据。实现细节可以按现有仓库命名约定调整，但不能改变下面的可观察语义。

## 决策摘要

1. V1 继续只允许一个活动 Goal、一个活动 Task 和一个 Worker Attempt。
2. 普通用户指令只在安全边界应用；已启动的 Provider 进程不被动态改写。
3. 路线图采用 immutable revision；历史 Task/Attempt/Verification 不原地编辑。
4. Retry 创建新 Attempt；Resume 只能从已确认边界继续。
5. 无法确认旧 Worker 状态时，进入 `NEEDS_HUMAN`，绝不自动重复启动。
6. 所有会产生副作用的控制命令都需要 idempotency key；路线图/指令写入还需要 expected revision。
7. “删除未来 Task”在领域层是带原因的 `SKIPPED`，不是物理删除。
8. Goal 只能由独立验证流程进入 `COMPLETED`；Planner、Worker、用户编辑都没有完成权限。
9. 高风险动作必须有精确范围的 Approval；不支持细粒度权限的 Provider 只能降级或请求人工。
10. WebSocket 只负责实时提示，重连后的真实状态必须从 HTTP/SQLite 快照恢复。

## 1. 状态机

### 1.1 Goal

```text
CREATED -> PLANNING -> RUNNING <-> VERIFYING
   |          |           |          |
   v          v           v          v
PAUSED <-----------------------------+
   |\                                 |
   | \                                v
   |  +-----------------------> NEEDS_HUMAN
   |                                  |
   +----------------------------------+

VERIFYING -> COMPLETED   (仅 Final Verifier PASS)
VERIFYING -> FAILED      (确定性失败且策略确认不可继续)
任何非终态 -> ABORTED    (显式 Abort 或不可恢复的安全终止)
```

允许的迁移以当前 storage 的显式表为准：

| From | Allowed To | 触发条件 |
| --- | --- | --- |
| `CREATED` | `PLANNING` | 首次启动或 Resume 需要重新规划 |
| `CREATED` | `PAUSED`/`NEEDS_HUMAN`/`ABORTED` | 预检、人工暂停或拒绝 |
| `PLANNING` | `RUNNING` | 得到可执行 Task Contract |
| `PLANNING` | `PAUSED`/`NEEDS_HUMAN`/`ABORTED` | 信息不足、冲突或显式控制 |
| `RUNNING` | `VERIFYING` | Attempt 已结束并提交证据 |
| `RUNNING` | `PAUSED`/`NEEDS_HUMAN`/`FAILED`/`ABORTED` | 控制、风险、预算或运行失败 |
| `VERIFYING` | `RUNNING` | 进入有界 Repair Attempt |
| `VERIFYING` | `COMPLETED` | Final Verifier PASS |
| `VERIFYING` | `FAILED`/`NEEDS_HUMAN`/`PAUSED`/`ABORTED` | 验证失败、未知或控制 |
| `PAUSED` | `PLANNING`/`RUNNING` | 安全 Resume；不能直接跳过规划/验证 |
| `NEEDS_HUMAN` | `PLANNING`/`RUNNING` | 人工解决原因后 Resume |
| `COMPLETED`/`FAILED`/`ABORTED` | 无 | 终态不可重启或改写 |

V1 不添加新的终态来掩盖恢复不确定性；使用 `NEEDS_HUMAN` 加结构化 reason code 表达需要人工判断的原因。

### 1.2 Task

```text
PENDING -> RUNNING -> VERIFYING -> COMPLETED
   |          |           |
   |          v           v
   +------> SKIPPED   REPAIRING -> RUNNING
              |
              v
         NEEDS_HUMAN / FAILED
```

规则：

- `PENDING` 才能被插入、编辑、重排或安全跳过。
- `RUNNING`、`VERIFYING`、`REPAIRING` 是活动边界，普通 Roadmap edit 不得改变其 Contract。
- `COMPLETED`、`FAILED`、`SKIPPED` 是历史结果，不原地编辑。
- `NEEDS_HUMAN` 只能在明确解决原因后进入 `RUNNING` 或 `SKIPPED`。
- `SKIPPED` 必须有 reason，并在 Goal Final Verification 中重新检查是否留下 requirement gap。

### 1.3 Attempt 与 Verification

- Attempt 状态只能表示该次 Worker 生命周期：`CREATED → RUNNING → COMPLETED/FAILED/INTERRUPTED/NEEDS_HUMAN`。
- Retry 永远使用新的 Attempt ID 和递增的 `attemptNumber`。
- VerificationRun 是 append-only；每次验证都保存输入引用、deterministic checks、evidence 和 reason。
- Provider 的“完成”输出只写入 WorkerResult，不直接写入 Task/Goal 完成状态。

## 2. 安全边界

### 2.1 安全边界定义

以下时点允许消费待应用 Instruction、刷新 Project State、生成 MemorySnapshot 和 rolling plan：

1. Goal 首次 planning 完成之前。
2. Attempt 已产生终态且 VerificationRun 已持久化之后。
3. 用户显式 Pause 成功之后。
4. Goal 已进入 `NEEDS_HUMAN` 之后。
5. Server 恢复确认旧 Attempt 不再运行之后。

以下情况不应用普通 Instruction：

- Provider 进程正在运行或状态未知。
- 当前 Task 正在 `VERIFYING` 且证据尚未落库。
- Instruction 的 base revision 已过期且无法安全合并。
- Instruction 要求高风险动作但 Approval 尚未通过。

紧急停止不等待安全边界：使用 Pause/Abort；系统必须记录控制事件并尽力终止/收尾当前进程。

### 2.2 Instruction 处理结果

```text
PENDING -> APPLIED
        -> REJECTED
        -> NEEDS_APPROVAL
        -> NEEDS_CLARIFICATION
        -> SUPERSEDED
```

`NEEDS_APPROVAL` 和 `NEEDS_CLARIFICATION` 是指令处理结果，不是 Goal 终态；对应 Goal 在无法继续时进入 `NEEDS_HUMAN`。

每条已应用指令必须记录：

- 应用的 Goal、Task 和 Attempt 边界。
- 应用前后的 RoadmapRevision 与 MemorySnapshot revision。
- 影响的 Contract 字段或约束。
- 应用决策和 reason code。

## 3. Roadmap Revision 语义

### 3.1 Revision 不可变

- 每次 Initial Planner、Rolling Planner 或用户编辑都创建新 revision。
- revision 记录 parent revision、source、reason、actor 和完整任务顺序快照。
- active revision 只通过事务切换；旧 revision 永远可读。
- 页面刷新、WebSocket 重连和恢复流程均以 active revision 为准。

### 3.2 用户与 Planner 的合并优先级

优先级从高到低：

```text
原始 Goal / LOCKED 约束
    > 已确认的人工 revision / Instruction
    > 已验证事实与 deterministic evidence
    > STABLE architecture decision
    > Planner 对 tentative Task 的建议
```

如果 Planner 输出与 LOCKED 或人工 revision 冲突：

- 不覆盖人工数据。
- 记录冲突 diff。
- 输出 `NEEDS_HUMAN` 或请求 INSPECT。
- 不能通过把 Task 标为 `SKIPPED` 来隐藏冲突。

### 3.3 编辑权限

| 对象 | 普通编辑 | 允许的替代动作 |
| --- | --- | --- |
| 已完成/失败/跳过 Task | 禁止 | 新增 follow-up Task，保留原记录 |
| 当前运行 Task | 禁止 | Pause 后提交新 revision，或用 Instruction 在下一边界生效 |
| 未来 `PENDING` Task | 允许 | 新 revision + Contract 校验 |
| 关键 requirement 对应 Task | 可编辑但需影响分析 | 不能静默移除 requirement |
| Goal 原始 prompt/LOCKED constraint | 禁止原地覆盖 | 新增 Instruction 或创建新的 Goal |

## 4. Resume、Retry 与恢复

### 4.1 Resume

Resume 的前置条件：

- Goal 状态是 `PAUSED` 或 `NEEDS_HUMAN`，且原因已被解决或用户明确确认。
- 没有仍在运行或状态未知的旧 Attempt。
- 当前数据库 generation/lease 属于本次 Resume。
- Project State、Working Set 和 Memory 已重新采集或明确记录无法采集。

Resume 的顺序固定为：

```text
获取 lease
 -> 重新读取 Goal/Task/Attempt
 -> 恢复/拒绝 pending Instructions
 -> 刷新 Project State / Working Set
 -> 应用可用 revision
 -> Planning 或从安全 Task 边界继续
 -> 持久化 resume event
```

Resume 不得：跳过未验证 Task、复用旧 Attempt ID、清除失败 evidence、重置尝试次数或让 Goal 直接变成 COMPLETED。

### 4.2 Retry

Retry 只适用于 Verification `FAIL`/明确 retryable Worker failure，且剩余 attempts 与预算足够。Retry 输入至少包含：

- parent Task/Attempt。
- 失败 criterion/check 和 evidence 引用。
- 当前 Project State 和相关变更。
- 新的 repair objective。

不可重试的认证、权限、秘密、不可逆副作用和状态未知问题直接转 `NEEDS_HUMAN`。

### 4.3 恢复分类

| 分类 | 条件 | 动作 |
| --- | --- | --- |
| `SAFE_TO_RESUME` | 无旧 Worker，边界和状态完整 | 获取新 lease 后继续 |
| `STILL_RUNNING` | 旧 Session/进程可证明仍存活 | 不启动新 Attempt，等待或人工控制 |
| `RETRYABLE` | 旧 Attempt 已失败且可重试 | 创建新 Attempt |
| `NEEDS_HUMAN` | 状态、证据或所有权无法确认 | 不启动，展示原因 |
| `TERMINAL` | Goal 已完成/失败/中止 | 只读展示 |

## 5. Lease、幂等与并发

### 5.1 Lease

- 一个 Goal 同时最多一个有效 lease。
- lease 包含 owner、generation、heartbeat 和 expiry。
- 所有写入携带 generation；旧 owner 的延迟写入必须被拒绝。
- Server 重启不自动清除未过期 lease；过期接管必须产生 recovery event。
- lease 不是完成证据，不能代替 Attempt/Verification。

### 5.2 幂等命令

以下命令必须接收 idempotency key：

```text
Start, Pause, Abort, Continue, Resume, Retry,
Give Instruction, Approve, Reject,
Roadmap edit, insert, skip, reorder, Archive
```

相同 key 和相同 payload 返回第一次结果；相同 key 不同 payload 返回冲突，不产生副作用。控制命令响应应包含：

- commandId / idempotencyKey。
- resulting entity revision。
- applied/rejected/conflict reason。
- 关联 event ID。

### 5.3 乐观并发

Roadmap、Instruction 和 Memory 写入必须带 expected revision。版本已变化时返回稳定 `revision_conflict`，客户端重新
读取并显示差异，不自动覆盖。

## 6. 风险与审批

动作默认按以下顺序升级风险：

```text
read
 < workspace-write
 < process
 < network
 < secret
 < destructive
 < remote-side-effect
```

- 未知动作按高风险处理。
- 高风险动作必须创建精确 ApprovalRequest，绑定 Goal/Task/Attempt、action、scope、revision 和 expiry。
- Approval 只允许批准当前精确范围，不形成永久 Provider 权限。
- Provider 不支持所需限制时，不用危险 flag 绕过；转 NEEDS_HUMAN 或缩小 Task。
- Approval、reject、expiry 都写入审计事件。

## 7. 完成与进度判定

### 7.1 完成权限

| 角色/动作 | 可创建 Task | 可修改 Contract | 可标记 Task completed | 可标记 Goal completed |
| --- | --- | --- | --- | --- |
| Planner | 建议/创建待执行 Task | 仅 tentative 区域 | 否 | 否 |
| Worker | 否 | 否 | 只能提交 claim | 否 |
| Verifier | 否 | 否 | 是（基于证据） | 仅 Final Verifier PASS |
| 用户 Roadmap edit | 插入/修改未来 Task | 有限 | 否 | 否 |
| Recovery | 否 | 否 | 否 | 否 |

### 7.2 Progress/ETA

- Task 已验证完成时 progress 必为 100%。
- Goal 在 Final Verification PASS 前不得显示 100%。
- 新 Gap Task、repair 或 uncertainty 必须降低/冻结相应投影并说明原因。
- ETA 使用区间、样本数和置信度；数据不足时显示 `Unavailable` 或低置信度宽区间。
- Progress/ETA 是投影，不修改领域状态，不作为完成证据。

## 8. 事件与审计

下列动作必须 append-only 记录 event：

- 状态迁移、lease 获取/释放/接管。
- Instruction 接收/应用/拒绝/替代。
- Roadmap revision 创建/激活/冲突。
- Recovery 分类和 Resume/Retry 决策。
- Approval 请求/批准/拒绝/过期。
- Budget warning/exceeded。
- Progress/ETA snapshot 的重要变化。

Event payload 只放结构化摘要和引用；原始密钥、`.env` 内容和不必要的完整用户输入不进入日志或 Dashboard。

## 9. HTTP、WebSocket 与错误码

### 9.1 HTTP 约束

所有 V1 command endpoint 都必须在执行副作用前完成：

1. 请求 schema 校验。
2. Goal/Task/Attempt 状态检查。
3. expected revision / lease / approval 检查。
4. idempotency 查询。
5. 单事务写入实体和 event。
6. 返回结果与稳定错误码。

建议错误码：

```text
invalid_request
not_found
invalid_orchestrator_state
revision_conflict
idempotency_conflict
lease_conflict
approval_required
budget_exceeded
provider_capability_unavailable
needs_human
```

### 9.2 WebSocket 约束

- 广播与数据库写入顺序一致；事件丢失不影响最终状态。
- 客户端收到未知事件类型时保留连接并重新获取快照。
- 通知和 metric event 要求 eventKey/节流，避免重连风暴。
- 页面不得仅根据事件数量或到达顺序自行推断完成。

## 10. 兼容与迁移要求

- V1 migration 只追加，不删除或重命名 V0 表字段。
- V0 Goal 没有 revision/lease/instruction 时按初始 revision 读取，并显示“历史数据/能力有限”。
- 原有 `run claude`、`run codex`、TTY、structured、app-server、Session 删除/隐藏与 Dashboard 路径不改变。
- Orchestrator 新功能只能通过 Server/Core 接入，浏览器不直接启动 Provider。
- Provider 能力缺失必须显示 `Unavailable` 或 `not reported`，不猜测 token、cost、milestone 或 tool call。

## 11. 测试判定表

实现每个控制功能时至少加入以下表驱动案例：

| 案例 | 期望 |
| --- | --- |
| 重复相同 command key | 同一结果，无重复 Attempt/revision/event 副作用 |
| 相同 key 不同 payload | `idempotency_conflict` |
| 过期 roadmap revision | `revision_conflict`，数据不改变 |
| 旧 generation 写入 | `lease_conflict`，数据不改变 |
| 活动 Attempt 上提交普通 Instruction | PENDING，边界后再应用 |
| Instruction 违反 LOCKED 约束 | REJECTED 或 NEEDS_HUMAN |
| 跳过关键 requirement Task | SKIPPED，但 Final Verifier 生成 gap |
| Worker claim completed、证据失败 | Verification FAIL/UNCERTAIN，不完成 |
| Server 在 Attempt 中途重启 | 不重复启动；无法确认则 NEEDS_HUMAN |
| Provider rate limit | 有界 retry/backoff 或 NEEDS_HUMAN |
| Provider auth/permission failure | 不重试无限次，进入 NEEDS_HUMAN |
| 无 ETA 历史 | Unavailable/低置信度，不伪造精确值 |

## 12. 与 V2 的边界

本 ADR 不为 V2 实现并行 Worker、DAG、worktree、自动 merge、智能 Router、跨机器或团队治理。V1 只通过接口和
事件命名保留扩展空间；如果某项实现需要引入这些行为，应先停止并重新评估版本边界。
