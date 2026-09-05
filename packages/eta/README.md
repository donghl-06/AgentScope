# ETA package

基于 elapsed、progress、失败、阻塞和信号质量计算区间 ETA、confidence 与 reasons。进度
低于阈值时返回宽的 `insufficient_data` 区间；终态返回零区间，不保留过期 ETA。

失败验证、阻塞、低信号、验证未完成和重规划倍率全部集中在 `EtaConfig`；`replanningDetected` 或 failed milestone 会显式增加 penalty 并留下 `replanning_penalty` reason。
