# kokoro-billing SLO 与告警基线

本文定义生产目标、测量口径和告警阈值，不代表当前环境已经达到这些数值。上线前必须由生产遥测建立基线；
看板应同时展示目标、实际值、样本量和统计窗口，不使用测试或本地 fixture 数据冒充生产实测。

## SLI 与目标

| Surface | Availability SLI / 30 天目标 | 延迟或队列目标 | 统计口径 |
|---|---|---|---|
| Billing API | 合格请求中非 Billing 5xx 的比例 `>= 99.90%` | p95 `<= 300 ms`，p99 `<= 800 ms` | `/v1/**`；排除客户端取消、契约内 4xx 与 `/healthz`、`/readyz`、`/metrics` |
| Ledger read/write | 合格 ledger 读请求成功率 `>= 99.95%`；已确认账务命令原子写入成功率 `>= 99.99%` | 读 p95 `<= 200 ms`，p99 `<= 500 ms`；账务事务 p95 `<= 500 ms`，p99 `<= 1.5 s` | 读由 HTTP histogram；写由命令结果与 journal/receipt 对账；projection drift 必须为 `0` |
| Outbox | 在投递期限内完成 publish 的 outbox 比例 `>= 99.90%` | pending age p95 `<= 30 s`，p99 `<= 120 s` | `created_at` 到 published/dead-letter 终态；按 outbox 类型分组，不把重试重复计为新事件 |
| Payment event | 已通过签名并持久化的 provider event 最终处理成功率 `>= 99.95%` | webhook 接收 p95 `<= 150 ms`、p99 `<= 500 ms`；received→processed p95 `<= 30 s`、p99 `<= 120 s` | 排除签名失败、tenant mismatch 和 provider 明确拒绝的无效事件；重复事件按稳定 provider event ID 去重 |

延迟分位数使用滚动 30 分钟窗口告警、30 天窗口报告；低流量窗口必须同时展示样本量，样本不足时只告警绝对失败或
队列年龄。Availability 按请求/事件计数，不用进程存活时间代替。

## Provider 错误 SLI

- `provider_retryable_error_ratio = retryable provider failures / provider attempts`，按 provider、operation 分组。
- 客户主动取消、支付方式拒绝等契约内业务终态不计入 provider 可用性错误；连接/读取/总 deadline、HTTP 429、
  provider 5xx 与连接重置计入。
- warning：任一 provider 在至少 20 次尝试下，10 分钟错误率 `> 5%`。
- critical：任一 provider 在至少 20 次尝试下，5 分钟错误率 `> 10%`，或 15 分钟连续无成功请求。
- 重试只针对具备稳定幂等键的可重试操作；告警和 SLI 同时观察初次尝试与最终结果，避免重试掩盖退化。

## 错误预算

| 目标 | 30 天最大不可用预算（时间等价值） | 事件/请求预算 |
|---|---:|---:|
| 99.90% | 43 分 49 秒 | 最多 0.10% 不合格事件/请求 |
| 99.95% | 21 分 55 秒 | 最多 0.05% 不合格事件/请求 |
| 99.99% | 4 分 23 秒 | 最多 0.01% 不合格事件/请求 |

预算是发布决策约束，不是允许丢账。Ledger 重复、丢失、跨 tenant 污染或 projection drift 属于账务不变量事故；出现
一例即按 critical 处理，不以剩余 availability 预算抵扣。30 天预算消耗 `>= 50%` 时暂停非必要风险发布，`>= 75%`
时只允许可靠性/安全修复，耗尽时冻结常规发布直至恢复窗口并完成复盘。

## 告警阈值

| 信号 | Warning | Critical / page |
|---|---|---|
| Availability burn rate | 6 小时窗口 `> 2x` 持续 30 分钟 | 1 小时 `> 14.4x` 且 5 分钟同样超限；或 6 小时 `> 6x` 且 30 分钟同样超限 |
| API/ledger latency | p95 超目标 15 分钟 | p99 超目标 10 分钟，或 deadline 错误率 5 分钟 `> 2%` |
| Outbox pending age | oldest pending `> 60 s` 持续 10 分钟 | oldest pending `> 300 s` 持续 5 分钟，或新增 dead-letter `> 0` |
| Payment event lag | p95 `> 60 s` 持续 10 分钟 | p99 `> 300 s` 持续 5 分钟，或最老 received event `> 10 min` |
| Provider errors | 10 分钟 `> 5%`（满足最小样本） | 5 分钟 `> 10%`（满足最小样本）或 15 分钟无成功 |
| Ledger correctness | reconciliation drift 始终为 `0` | 任一 drift、重复 journal sequence、跨 tenant 关联或 receipt/journal 不一致立即 page |

告警必须带 `service`、`operation`、`request_id`/`trace_id`（可用时）、provider、队列类型、最老事件年龄与部署版本；
日志和告警标签不得包含 token、签名、secret 或完整支付载荷。

## 响应与 Runbook

处置步骤见 [kokoro-billing 运行说明](RUNBOOK.md)：先判定 API、PostgreSQL、Redis、provider 或 worker 故障域，再按
outbox/payment event/ledger 专项步骤止损、重放或对账。所有重放必须使用原稳定幂等标识；账务不变量告警禁止通过
手工改余额消警。
