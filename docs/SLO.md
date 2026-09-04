# kokoro-billing SLO 与告警基线

本文定义生产目标和测量口径，不代表当前环境已经达到这些数值。仓库目前没有生产 traffic、dashboard、alert rule 或
SLO attainment 证据；任何达标声明必须附带部署版本、统计窗口、样本量和可复核数据源。

## 1. SLI 与目标

| Surface | 30 天目标 | 延迟/队列目标 | 统计口径 |
|---|---|---|---|
| Billing API | 合格请求 availability `>=99.90%` | p95 `<=300 ms`，p99 `<=800 ms` | `/v1/**`；排除客户端取消、契约内 4xx 与运行探针 |
| Ledger read/write | 读 `>=99.95%`；已确认原子写入 `>=99.99%` | 读 p95 `<=200 ms`；事务 p95 `<=500 ms`、p99 `<=1.5 s` | read HTTP；write receipt/journal/reconcile；drift 必须为 0 |
| Payment outbox | deadline 内 publish `>=99.90%` | pending age p95 `<=30 s`、p99 `<=120 s` | created 到 published/dead-letter；retry 不计新 event |
| Provider event | 已验证并入 inbox 的事件最终处理 `>=99.95%` | ingress p95 `<=150 ms`；received→processed p95 `<=30 s`、p99 `<=120 s` | 按稳定 provider event ID 去重，排除签名失败/无效事件 |
| Execution event | 已认证并入 inbox 的事件最终处理 `>=99.95%` | received→processed p95 `<=30 s`、p99 `<=120 s` | tenant + event ID 去重；unknown 单独计数 |
| Credit expiry | 到期后 5 分钟内收敛 `>=99.90%` | oldest overdue hold p99 `<=300 s` | active hold expires_at 到 captured/released/expired |

Availability 以请求/event 计数，不用进程 uptime 代替。低流量窗口同时展示样本量；样本不足时只用绝对 failure、oldest age
和账务不变量 page。

## 2. 当前 instrumentation

| 信号 | 当前状态 | 数据源 |
|---|---|---|
| HTTP count/status | 已实现 | `billing_http_requests_total` |
| HTTP latency | 已实现 | `billing_http_request_duration_seconds` |
| Payment worker result | 已实现 | `billing_worker_results_total{result}` |
| Payment oldest pending | 已实现 | `billing_worker_oldest_pending_age_seconds` |
| Expiry run completed/skipped | 已实现 | `billing_expiry_runs_total{result}` |
| Default process metrics | 已实现 | API/worker Prometheus registry |
| Provider retryable error ratio | 缺口 | 无直接 metric |
| Execution event lag/oldest | 缺口 | 无直接 metric |
| Entitlement outbox lag | 缺口 | 未装配 publisher/metric |
| Reconciliation drift | 缺口 | 有 query/report，无 runtime metric |
| Receipt/journal invariant | 缺口 | 无连续 metric/alert |
| PostgreSQL pool/lock saturation | 缺口 | 依赖外部数据库 telemetry，仓内未声明 dashboard |

Metrics 存在只证明可采集，不证明 scraper、dashboard 或 alert 已部署。

## 3. Provider 错误 SLI

`provider_retryable_error_ratio = retryable provider failures / provider attempts`，按 provider/operation 分组。Client cancel、
支付方式拒绝等业务终态不计入 provider availability；connect/read/overall timeout、429、5xx 与连接重置计入。

- Warning：至少 20 次尝试时，10 分钟比率 `>5%`。
- Critical：至少 20 次尝试时，5 分钟比率 `>10%`，或 15 分钟无成功。
- 初次尝试与最终结果分开观测，避免 retry 掩盖退化。

该 metric 当前未实现，阈值是目标门禁。

## 4. 错误预算

| 目标 | 30 天时间等价值 | 事件/请求预算 |
|---|---:|---:|
| 99.90% | 43 分 49 秒 | 0.10% |
| 99.95% | 21 分 55 秒 | 0.05% |
| 99.99% | 4 分 23 秒 | 0.01% |

Ledger 重复、丢失、跨 tenant 污染、receipt mismatch 或任一 reconciliation drift 是正确性事故，出现一例立即 critical，
不由 availability 预算抵扣。30 天预算消耗 `>=50%` 暂停非必要高风险发布，`>=75%` 只允许可靠性/安全修复，耗尽时冻结
常规发布并复盘。

## 5. 告警目标

| 信号 | Warning | Critical / page |
|---|---|---|
| Availability burn | 6h `>2x` 持续 30m | 1h `>14.4x` 且 5m 同超；或 6h `>6x` 且 30m 同超 |
| API/ledger latency | p95 超目标 15m | p99 超目标 10m；或 deadline error 5m `>2%` |
| Payment outbox | oldest `>60 s` 持续 10m | oldest `>300 s` 持续 5m；或新增 dead-letter |
| Execution event | p95 `>60 s` 持续 10m | oldest received `>10 min` 或 failed 增长 |
| Credit expiry | oldest overdue `>120 s` | oldest overdue `>300 s` 或 projection drift |
| Provider errors | 10m `>5%` 且样本足 | 5m `>10%` 且样本足；或 15m 无成功 |
| Ledger correctness | drift 始终为 0 | 任一 drift/重复 sequence/跨 tenant/receipt mismatch |

告警至少携带 service、operation、部署版本、provider/queue、oldest age 与可用的 request_id/trace_id；不得把 tenant、token、
signature、secret 或完整 payment payload 放入高基数 label。

## 6. 发布与复核

- 周报/发布评审展示目标、实际值、样本量、窗口、缺失数据和 deploy digest。
- Alert rule 与 dashboard 变更需代码审查；当前仓库尚无这些配置。
- 每次 critical 事件关联 [`RUNBOOK.md`](RUNBOOK.md)、timeline、影响 tenant 范围、账务不变量检查与 follow-up owner。
- SLO 目标只有在至少一个完整 30 天生产窗口后才可评估；本地/CI 数据不参与达标计算。
