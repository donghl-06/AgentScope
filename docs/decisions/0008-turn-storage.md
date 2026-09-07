# ADR-0008：V1 Turn 使用独立 projection 表

- 状态：Accepted
- 日期：2026-09-07

## 决策

V1 在 SQLite 中新增 `turns` 表，保存每一轮的生命周期和 projection；V0 `events` 表继续保持
session 级顺序，不在本次迁移中强制增加 `turn_id` 列。turn 事件仍可通过统一协议广播，后续
turn coordinator 稳定后再决定是否为事件增加可空关联列。

## 原因

1. 保留 V0 数据库和 consumer 的读取兼容性，历史 session 不需要回填虚假的 turn。
2. turn 列表、状态过滤和 Dashboard 导航不必扫描完整 timeline。
3. turn projection 可以在 transaction 中独立更新，并遵守 transaction-before-broadcast 顺序。
4. 未来增加 event-to-turn 关联时，可以使用可空迁移列或映射表，不改变现有 turn API。

## 迁移和恢复

- `0003_turns` 只创建新表和索引，不修改现有 V0 表。
- 没有 turn 的历史 session 继续按 legacy 单任务展示。
- turn state JSON 与结构化列同时保存；读取时以 state JSON 做完整 schema 校验。
- 创建、更新和列表接口在 session 外键约束下工作；重复 `(session_id, sequence)` 会归一化为
  storage conflict。
