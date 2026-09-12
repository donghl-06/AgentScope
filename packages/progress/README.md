# Progress package

基于 milestone、activity 和客观验证证据计算可解释、可回退的 `value/confidence/reasons`。
Progress 不按时间自动增长；运行中的任务没有足够证据时会保留安全上限并降低
confidence。已经进入 `completed` 的 Session 表示执行本身已结束，因此执行进度为
100%；验证（tests/build/typecheck）仍作为单独的 verification 结果展示，不会把“未报告
验证”误写成执行未完成。

调用方可以通过 `ProgressConfig.requiredVerification` 声明项目真正使用的验证门（例如只要求 tests）。未声明时默认要求 tests、build、typecheck 全部通过；显式声明空列表表示不需要验证门，但不会改变运行中任务的证据上限。
