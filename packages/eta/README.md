# ETA package

基于 elapsed、progress、失败、阻塞和信号质量计算区间 ETA、confidence 与 reasons。进度
低于阈值时，如果没有足够的历史完成时长，会返回宽的 `insufficient_data` 区间；有至少
`minHistorySamples` 个同 provider/adapter 的完成 Session 时，会用历史 P25/P50/P75
作为保守基线，并保留 `history_baseline`、`history_range` 或 `history_insufficient` 理由。
终态返回零区间，不保留过期 ETA。

失败验证、阻塞、低信号、验证未完成和重规划倍率全部集中在 `EtaConfig`；`replanningDetected` 或 failed milestone 会显式增加 penalty 并留下 `replanning_penalty` reason。历史样本不足时不会伪造精确 ETA；随着有效样本增加，区间和 confidence 才逐步收敛。

当运行时间超过可比历史的 P75 时，估计会留下 `history_overrun` reason，并按
`historyOverrunConfidenceFactor`（默认 `0.65`）降低 confidence；区间会基于新的 elapsed
重新计算，避免继续显示已经失效的旧基线。
