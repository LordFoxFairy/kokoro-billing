# kokoro-billing 可靠性设计

## 1. 正确性优先级

```text
PostgreSQL fact / row lock / UNIQUE / CHECK / durable receipt
  > application state machine and reconciliation
  > outbox/inbox retry
  > Redis idempotency hint and lease
  > process memory
```

Redis 与 metrics 均不是账务正确性依赖。任何降级都必须保留 PostgreSQL receipt、journal、hold/allocation 与 tenant 约束。

## 2. Dependency timeout

| 依赖 | 当前配置 |
|---|---|
| PostgreSQL pool connect | 10 s；idle 30 s；pool size 默认 10、最小 2 |
| Redis | connect 2 s、read 1 s、overall 3 s；均可由 `REDIS_*_TIMEOUT_MS` 调整 |
| Stripe | connect 3 s、read 10 s、overall 12 s；均可由 `STRIPE_*_TIMEOUT_MS` 调整 |
| API shutdown | 默认 10 s，由 `BILLING_SHUTDOWN_DEADLINE_MS` 调整 |
| Payment worker poll | 默认 1 s，允许 100 ms–60 s |
| Expiry worker poll | 默认 5 s，允许 500 ms–300 s |

Redis 仅对可重复 operation 最多尝试两次，并受 overall deadline 限制。Stripe checkout POST 使用稳定 provider idempotency key，
`maxNetworkRetries=1`，并有独立 overall timer。

当前 API handler 没有统一 overall request deadline，PostgreSQL query 也没有 per-statement deadline；这是已知缺口。

## 3. 幂等与不确定结果

| 写路径 | Durable identity |
|---|---|
| Checkout | tenant + Idempotency-Key；quote hash 检测 payload drift |
| Admission/capture/release | `entitlement_billing_command_receipt` + payload hash/result |
| Credit/usage/admin/redeem 内部命令 | command receipt、业务 source UNIQUE 或一对一事实 |
| Execution event | tenant + event ID，另存 payload hash |
| Provider webhook | tenant + provider + external event ID，另存 payload hash |
| Settlement/reversal | stable settlement/external reference、reversal identity/receipt |
| Expiry | active status + row lock；重复 sweep 跳过终态 |

Redis hint 的 claim/replay/conflict 只优化入口；失败时 handler 继续到 PostgreSQL。调用方遇到 timeout/409/unknown 时复用原 identity，
不得用新 key 猜测重试。

## 4. Inbox、outbox 与 worker

### Payment event

Webhook 在事务内写 provider inbox 和 payment outbox。Worker：

1. 以 `FOR UPDATE SKIP LOCKED` 领取最早 eligible row；
2. 写 30 秒 lease 和 attempt；
3. 在独立 lease connection 上续租；
4. 调用 provider-event application processor；
5. 成功写 `published_at`；失败按 capped attempt delay 重试；
6. 达到 `BILLING_OUTBOX_MAX_ATTEMPTS`（默认 10）写 `dead_lettered_at`；
7. lease owner 丢失时返回 `lease_lost`，不误写 publish。

Payment worker metrics 暴露 result totals 与 oldest pending age。

### Execution event

Ingress 先写 `entitlement_execution_event.status=received`。Batch script 按 occurred time/ID 读取最多 500 条并逐条处理；失败保留并
写 stderr，后续 batch 可重试。当前领取没有 row lease/`SKIP LOCKED`，因此不应并行运行多个实例，直到并发门禁补齐。

### Expiry

Redis lease 提供 leader 协调；Redis 不可用时实现会继续执行 task，让 PostgreSQL row lock/status 幂等保证正确性。每个 hold 独立事务，
单条失败会终止当前 sweep；下次运行可继续处理仍为 active 的行。

### Entitlement outbox

Schema 与通用 `OutboxWorker` 支持 `entitlement_outbox`，但当前发布脚本只明确消费 payment outbox。Entitlement event 的实际
publisher/consumer routing 尚未装配，不能把表存在当作已交付集成。

## 5. 事务与故障恢复

- API/worker operation 使用 context-scoped PostgreSQL session；嵌套 application transaction 使用 savepoint。
- Account/grant/hold/allocation/journal/outbox 在同事务写入；任何异常 rollback。
- Provider network call 与账务事务分离；本地 fact 可用于不确定结果后的重放/对账。
- Payment lease 与 business transaction 使用独立 connection，避免业务 rollback 撤销 lease owner。
- SIGTERM/SIGINT 触发 API resource close；超过 shutdown deadline 非零退出。
- Worker 在 signal 后停止领取新工作，并在当前 loop 边界关闭 metrics/connection。

## 6. 降级矩阵

| 故障 | 当前行为 | 正确性约束 |
|---|---|---|
| Redis hint timeout | 忽略 hint，继续 PostgreSQL | durable receipt/fact 决定 replay/conflict |
| Redis expiry lease timeout | 允许 sweep 继续 | PostgreSQL row lock/status 防重复记账 |
| PostgreSQL unavailable | readiness 503；账务路径失败 | 不降级到 Redis/内存写事实 |
| Provider timeout | 返回稳定 provider error/unknown，由原 key 重试 | 不重复创建无 key provider mutation |
| Metrics scrape/record failure | 返回空 metrics 或忽略记录失败 | 不改变业务 response |
| Payment handler failure | retry -> dead-letter | 保留 inbox/outbox 与 attempts |
| Lease lost | 不写 published | 新 owner 可重新领取 |
| Unknown execution outcome | 保留 admission hold | 仅受信 accepted/explicit failure 收敛 |

## 7. Reconciliation

现有 repository 检查：

- account projection vs grant remaining、journal sum、active hold 与 allocation；
- succeeded settlement 是否有 committed acquisition/fulfillment；
- succeeded reversal 是否有 committed fulfillment reversal；
- failed provider event。

报告只读返回 `ok|drift` 与明细。目前没有独立部署入口、定时调度、metric、alert 或受审计 repair command；出现 drift 时按 runbook
停止受影响写入并保存证据，不直接 UPDATE balance/journal。

## 8. 可观测性

已实现：

- `billing_http_requests_total`；
- `billing_http_request_duration_seconds`；
- `billing_worker_results_total`；
- `billing_worker_oldest_pending_age_seconds`；
- `billing_expiry_runs_total`；
- 结构化 request completion log。

目标但未实现：provider retryable error ratio、execution-event age、entitlement outbox age、receipt status、reconciliation drift、
ledger invariant 与 database lock/pool saturation 的直接 application metric/alert。SLO 看板不能用缺失信号推断达标。

## 9. 仍需验证

- PostgreSQL kill/restart、transaction abort、lock contention 与 pool exhaustion；
- Redis outage/slow read/lease loss；
- provider timeout/429/5xx 与 unknown result；
- worker crash before/after side effect、lease renewal failure、dead-letter replay；
- duplicate/out-of-order execution/provider event；
- backup restore、RPO/RTO 与 region-level recovery；
- sustained load、queue growth与 shutdown drain。

完成这些演练前，本文描述的是实现机制和目标，不是生产可靠性证明。
