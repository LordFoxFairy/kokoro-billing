# ADR-0001：Billing 模块化单体与 PostgreSQL 账务权威

- Status：Accepted
- Date：2026-09-03
- Owner：kokoro-billing

2026-09-08：PG authority、Billing owner与幂等不变量继续有效；本文ports/旧分层路径是当前基线证据，不再作为目录强制规则。
Nest/Prisma目标及事务内模块协作由[ADR-0003](0003-nestjs-prisma-sql-first-alignment.md)补充。

## Context

Payment、Checkout、Refund、Subscription、Credit、Metering 与 fulfillment 需要在单一 owner 内维护金额、余额、journal、receipt 与
跨 context 关系。拆出独立 Credit writer 会引入双写和跨服务账务事务；把 Redis 当作余额/幂等事实会在 TTL、failover 或丢失时
改变结果。

## Decision

1. Billing 作为一个可部署模块化单体，context 通过 application port/transaction 协作。
2. PostgreSQL 是 payment、credit、journal、receipt、inbox/outbox 与 reconciliation 的唯一 durable authority。
3. Redis 只承担不含 body/digest 的短 TTL idempotency key-presence marker 和 best-effort lease；它不返回 replay/conflict 裁决。
   Redis 故障、miss 或坏记录不改变结果，正确性由规范化 command、PostgreSQL row lock、状态、UNIQUE/CHECK 与幂等事实保证。
4. Scheduler 只调用 Billing command，不连接 Billing database；其他 owner 也不共享 Schema/Repository。
5. V1 使用唯一 canonical Schema、空库安装、无 migration 与无 FK；关系由 application transaction 和 reconciliation 维护。
6. 需要“key 重放”与“业务 command identity 重放”的命令同时保存两种 identity；settlement 使用 `settlement_id`，expiry 使用
   `batch_id`，并以 request digest 和持久化 result 处理冲突/重放。

## Consequences

- 需要严格 tenant predicate、固定 lock order、durable receipt、append-oriented journal 与 reconciliation。
- Provider network call 必须位于数据库事务外，并用稳定 provider idempotency identity。
- Redis outage 只影响 hint/lease 效率；PostgreSQL 健康时 API 保持 ready 并报告 Redis degraded，expiry 继续执行，且不触发
  内存/Redis 账务写入。
- Context 仍需保持代码/port 边界，不能退化为万能 BillingService。
- Reconciliation runtime、retention 与 DR 仍需单独交付；本决策不构成生产可靠性证据。

## Evidence in current source

- `database/schema.sql`；
- `src/application/*/ports/`；
- `src/infrastructure/postgres/`；
- `src/infrastructure/redis/`；
- `test/integration/durable-command-receipts.test.ts`；
- `test/architecture/ownership.test.ts`。
