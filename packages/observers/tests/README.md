# Test observer

识别 wrapper/adapter 已知的 test、build、lint、typecheck 命令及其验证结果。规则表只匹配
已知的 command name，不执行或拆解任意 shell；未知命令保持 `unknown`，不会因为退出码
为 0 就伪造测试通过。exit code `130/143` 会被标记为 interrupted。
