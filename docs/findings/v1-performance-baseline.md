# V1 性能与短时稳定性基线

**日期：** 2026-09-13  
**平台：** Windows `win32-x64`，Node.js `v24.14.1`  
**测试入口：** `tests/integration/orchestrator-performance-baseline.test.ts`

## 目的与范围

本基线用于锁定 V1 的查询、广播和串行状态释放行为，避免历史增长或重复运行引入明显回归。
它不是硬件无关的性能承诺，也不代替数小时或数天的生产 soak。测试使用临时 SQLite
数据库、临时 workspace 和合成 Worker，不访问网络、不调用真实 Provider，也不修改项目数据。

## 批量历史与广播结果

测试先写入 180 个 Goal，每个 Goal 4 个 Task、每个 Task 6 个 Event，再分页读取历史、读取
40 个 Goal 详情并广播 200 个 Event。一次代表性运行结果如下：

| 指标 | 结果 |
| --- | ---: |
| Goal / Task / Event（含广播） | 180 / 720 / 4520 |
| 历史分页 | 8 页（页大小 25） |
| 分页读取 P50 / P95 / 最大值 | 0 / 1 / 1 ms |
| 详情读取样本 / Event 数 | 40 / 960 |
| 详情读取 P50 / P95 / 最大值 | 0 / 0 / 0 ms |
| 广播 Event / 收到通知数 | 200 / 200 |
| 广播耗时 | 46 ms |
| SQLite 文件及 WAL/SHM 总大小 | 5,983,856 bytes |
| 进程 RSS 增量 | 228,876,288 bytes |
| CPU（user / system） | 500 / 531 ms |

Windows 当前计时精度会把许多亚毫秒读取四舍五入为 0 ms；这表示本次样本低于记录分辨率，
不是“零成本”或跨机器保证。测试只设置 2 秒的宽松回归上限，重点是检测异常增长、分页漏项
和通知丢失，而不是比较不同硬件的绝对速度。

## 串行短时 soak 结果

同一测试随后创建 120 个独立 Goal。每个 Goal 只有一个合成 Task，由一个串行 Worker 完成，
并经过 Task 验证和 Goal 最终验证。结果：

| 指标 | 结果 |
| --- | ---: |
| 循环次数 | 120 |
| 总耗时（代表性运行） | 11,783 ms |
| Goal / Task | 120 / 120 |
| 未完成 Goal | 0 |
| 持久化 Event | 1,320 |
| Engine active（结束时） | `false` |
| Worker active（结束时） | `false` |

这覆盖了重复 create→plan→attempt→verify→complete 的短时 listener、timer、lease 和活动状态
释放检查。它不宣称已经完成“数小时无故障”证明；长时 soak 仍应在目标部署机上单独执行，并记录
每小时的 RSS、CPU、SQLite 大小和错误计数。

## 可重复命令

```text
node node_modules/.pnpm/vitest@*/node_modules/vitest/vitest.mjs run --config vitest.integration.config.mjs --disableConsoleIntercept tests/integration/orchestrator-performance-baseline.test.ts
```

测试会在系统临时目录创建并清理数据库和 workspace。若要比较两次运行，应保留 Node、平台、
数据规模和测试命令；不要把单次本地数字直接转成产品 SLA。

## V1 结论

- 历史分页不会因为超过默认 100 条而静默漏项；测试显式遍历游标并读回全部 180 个 Goal。
- 详情读取与 Event 广播在当前合成规模下均在宽松回归上限内，订阅回调数量与写入数量一致。
- 120 次串行闭环结束后没有遗留活动 Goal 或 Worker，未观察到 listener/timer/lease 泄漏迹象。
- 真实 Provider 的延迟、token/cost 和跨机器资源曲线不从该合成基线推断；缺失数据继续显示
  `Unavailable`，符合 V1 的保守策略。
