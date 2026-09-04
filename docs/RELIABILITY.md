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
| Checkout | tenant + Idempotency-Key；versioned recursive-canonical command hash + checkout result |
| Admission/capture/release | tenant + surface + command + key receipt；invocation/admission identity + versioned digest/result |
| Credit/usage/admin/redeem 内部命令 | command receipt、业务 source UNIQUE 或一对一事实 |
| Execution event | tenant + command + Idempotency-Key receipt；event ID identity + versioned event digest/result |
| Provider webhook | tenant + provider + external event ID，另存 payload hash |
| Settlement acceptance | `payment_command_receipt`：tenant + command + key、`settlement_id` identity、versioned request digest/result |
| Reversal | `payment_command_receipt`：tenant + command + key、provider/external ref identity、versioned digest/result |
| Expiry | `entitlement_command_receipt`：tenant + command + key、`batch_id` identity、normalized limit digest/result |

Redis idempotency hint 只写 tenant/route/key 的短 TTL presence marker，不接收 body/digest，也不判定 replay/conflict。Redis
miss、timeout、坏记录、JSON 属性顺序以及省略/显式默认值都不改变 command 结果。PostgreSQL 在事务中核对 key、command
identity 与规范化 digest；成功后重放持久化 result。调用方遇到 timeout/409/unknown 时复用原 identity，不得猜测性换 key。

Authorize/capture/release/execution、settlement、refund 与 expiry 的 receipt claim、业务 effect 和 result 都在各自单一 PostgreSQL
transaction 内提交；未提交的 `processing` 对其他 transaction 不可见，异常会回滚 claim。因此通用 receipt 不使用时间 lease 或
stale reclaim。历史可见 `processing|unknown` 稳定返回 `billing.command_unknown`，`failed` 返回 `billing.command_failed`，由对账/
operator 决定后续动作。`succeeded` 的 result 缺失或不能通过 typed schema 时是 persistence invariant：外部只返回 generic 500，
内部结构化日志保留诊断 code。

Checkout 先读取/锁定 existing tenant/key 并比较 digest，只有新 command 才检查 database clock 和当前 sellable offer；因此 catalog
后续 disabled 不改变已成功命令。Refund 在 settlement lock 下以 `INSERT ... ON CONFLICT DO NOTHING` 和 receipt `FOR UPDATE`
收敛并发，避免唯一约束竞争成为 500。

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

Redis lease 提供 leader 协调；初始连接或 lease operation 失败时会继续执行 task，让 PostgreSQL receipt、row lock/status 保证正确性。
一个 expiry batch 的 receipt、所有选中 hold/allocation/account/outbox 和 result 在同一外层
transaction 提交；内部逐 hold savepoint 只提供结构化回滚。任一条失败会回滚整个 batch，原 identity 可安全重试。

### Entitlement outbox

Schema 与通用 `OutboxWorker` 支持 `entitlement_outbox`，但当前发布脚本只明确消费 payment outbox。Entitlement event 的实际
publisher/consumer routing 尚未装配，不能把表存在当作已交付集成。

## 5. 事务与故障恢复

- API/worker operation 使用 context-scoped PostgreSQL session；嵌套 application transaction 使用 savepoint。
- Account/grant/hold/allocation/journal/outbox 在同事务写入；任何异常 rollback。
- Settlement acceptance 将 receipt、settlement、payment outbox 与 result 原子提交；expiry 将 batch receipt、释放写入、entitlement
  outbox 与精确 hold ID result 原子提交。
- Admission command 将 receipt、admission/usage effect 与 result 原子提交；refund 将 receipt、reversal、audit/outbox 与 result
  原子提交。
- Provider webhook fact 与后续账务处理分离；Stripe checkout POST 使用稳定 provider idempotency key。Hosted-session provider call
  当前仍位于 checkout session transaction，是待收敛的 lock-duration 风险，不宣称已经完全事务外化。
- Payment lease 与 business transaction 使用独立 connection，避免业务 rollback 撤销 lease owner。
- SIGTERM/SIGINT 触发 API resource close；超过 shutdown deadline 非零退出。
- Worker 在 signal 后停止领取新工作，并在当前 loop 边界关闭 metrics/connection。

## 6. 降级矩阵

| 故障 | 当前行为 | 正确性约束 |
|---|---|---|
| Redis idempotency marker write/timeout | 忽略 marker 结果或错误，继续 PostgreSQL | normalized command 与 durable receipt/fact 决定 replay/conflict |
| Redis expiry lease operation timeout | 已连接后允许 sweep 继续 | PostgreSQL batch receipt/row lock/status 防重复记账 |
| Redis initial connect failure | API 继续启动；expiry 继续 batch；ready 返回 `redis=degraded` | PostgreSQL receipt/fact 保持唯一裁决 |
| PostgreSQL unavailable | readiness 503；账务路径失败 | 不降级到 Redis/内存写事实 |
| Provider timeout | 返回稳定 provider error/unknown，由原 key 重试 | 不重复创建无 key provider mutation |
| Metrics scrape/record failure | 返回空 metrics 或忽略记录失败 | 不改变业务 response |
| Payment handler failure | retry -> dead-letter | 保留 inbox/outbox 与 attempts |
| Lease lost | 不写 published | 新 owner 可重新领取 |
| Unknown execution outcome | 保留 admission hold | 仅受信 accepted/explicit failure 收敛 |

Redis 连接失败后当前进程禁用对应 hint/lease 优化，不在同一进程自动重连；supervisor 可受控重启恢复优化。无论是否重启或清空
Redis，都不需要重建 command result：API 从 PostgreSQL receipt/checkout/reversal facts 重放。

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
