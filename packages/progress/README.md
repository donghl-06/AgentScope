# Progress package

基于 milestone、activity 和客观验证证据计算可解释、可回退的 `value/confidence/reasons`。
Progress 不按时间自动增长；没有验证或信号不足时会保留上限并降低 confidence。

调用方可以通过 `ProgressConfig.requiredVerification` 声明项目真正使用的验证门（例如只要求 tests）。未声明时默认要求 tests、build、typecheck 全部通过；显式声明空列表也不会直接得到满分，仍保留完成但未验证的上限。
