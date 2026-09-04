# ADR-0001：Billing 模块化单体与 PostgreSQL 账务权威

- Status：Accepted
- Date：2026-09-03
- Owner：kokoro-billing

## Context

Payment、Checkout、Refund、Subscription、Credit、Metering 与 fulfillment 需要在单一 owner 内维护金额、余额、journal、receipt 与
跨 context 关系。拆出独立 Credit writer 会引入双写和跨服务账务事务；把 Redis 当作余额/幂等事实会在 TTL、failover 或丢失时
改变结果。

## Decision

1. Billing 作为一个可部署模块化单体，context 通过 application port/transaction 协作。
2. PostgreSQL 是 payment、credit、journal、receipt、inbox/outbox 与 reconciliation 的唯一 durable authority。
3. Redis 只承担短 TTL idempotency hint 和 best-effort lease；Redis 故障时正确性仍由 PostgreSQL row lock、状态、UNIQUE/CHECK
   与幂等事实保证。
4. Scheduler 只调用 Billing command，不连接 Billing database；其他 owner 也不共享 Schema/Repository。
5. V1 使用唯一 canonical Schema、空库安装、无 migration 与无 FK；关系由 application transaction 和 reconciliation 维护。

## Consequences

- 需要严格 tenant predicate、固定 lock order、durable receipt、append-oriented journal 与 reconciliation。
- Provider network call 必须位于数据库事务外，并用稳定 provider idempotency identity。
- Redis outage 可以影响 readiness/效率，不能触发内存/Redis 账务写入。
- Context 仍需保持代码/port 边界，不能退化为万能 BillingService。
- Reconciliation runtime、retention 与 DR 仍需单独交付；本决策不构成生产可靠性证据。

## Evidence in current source

- `database/schema.sql`；
- `src/application/*/ports/`；
- `src/infrastructure/postgres/`；
- `src/infrastructure/redis/`；
- `test/architecture/ownership.test.ts`。
