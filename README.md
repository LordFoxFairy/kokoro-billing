# kokoro-billing

Kokoro 的统一商业账务子仓库，承载支付事实、Credit grant/ledger 与卡密兑换；不拆出独立支付业务仓。

**Clean-build 约束：**对外和数据库统一使用 `tenantId` / `tenant_id`；不保留 `site_id`、旧 API、旧表或兼容 writer。
总体架构以 [`50-billing-commerce-rearchitecture.md`](../docs/kokoro-handbook/technical/50-billing-commerce-rearchitecture.md) 为准，
实现级目标契约以 [`51-billing-target-api-and-sql-contract.md`](../docs/kokoro-handbook/technical/51-billing-target-api-and-sql-contract.md) 为准。

## 当前状态

当前代码是前期 V1 探索实现和测试基线，**不等同于目标架构已实现，也不代表已上线**。以下能力是现有代码的局部参考，
不能作为 clean-build 目标完成证据；目标实现应从零按 50/51 文档建立。

现有探索实现包含的局部能力：

- CreditGrant 按 `expiresAt → burnPriority → issuedAt → grantId` 稳定分配；
- PostgreSQL 16 core migration 与 checksum migration runner；
- Payment settlement → Acquisition → Fulfillment → CreditGrant → CreditJournal 的事务切片；
- provider webhook inbox：签名门禁、原始 payload 保存、payload hash、external event id 重放幂等，并在同一事务写入 payment outbox；
- settlement/reversal source fact 与 Payment outbox 同事务写入，source event 唯一约束防止重复发布；
- 未消费 CreditGrant 的退款逆向分录与并发幂等；余额不足保留为 reconciliation exposure；
- usage event → authorization hold → actual settlement，按 grant burn order capture/release 并写 journal/outbox；
- checkout quote snapshot、PostgreSQL outbox lease/`SKIP LOCKED` worker 已加入实现切片；
- payment provider event worker 已有独立 `worker:payment-events` 入口；支付成功、退款和订阅周期均走可重试 processor，不对未映射事件猜测发放；worker 通过 PostgreSQL row lease 并行消费，不用 Redis 全局锁串行化吞吐；
- Stripe hosted Checkout 使用官方 `stripe` SDK；session 创建、webhook 验签和 provider idempotency 均不自定义协议；
- Entitlement catalog（offer + immutable offer revision）与 `/billing/plans` 已加入；Web BFF 只调用 Billing；
- local mock webhook 已复用 provider registry、inbox、payment settlement、fulfillment 和 grant 链路，不再维护第二套发放逻辑；
- Redeem code 已完成 CSPRNG/HMAC、campaign/batch/code/redeem schema、一次性 plaintext 返回、幂等 receipt、审计、兑换事务和 `/billing/redeem` 及 Admin API；plaintext 不进入数据库或 receipt；
- Redis idempotency hint 已接入 HTTP mutation fast-path；冲突可提前拦截，PostgreSQL receipt/事实仍是最终权威；
- Grant/hold expiry 由独立通用 `kokoro-scheduler` 触发 Billing 的公开内部 command；Billing 不保留独立 sweeper 服务；
- Admin grant/refund audit 与 account/grant/journal/settlement reconcile 已加入；
- Reconcile 已覆盖 account、settlement→fulfillment、reversal→fulfillment reversal、failed provider event，且 Admin 查询按 tenant 隔离；
- Payment 与 Entitlement/Credit 使用各自的 durable command receipt（`payment_command_receipt` / `entitlement_command_receipt`）；
- Admin provider event 查询支持状态筛选、租户隔离、opaque cursor 分页和带 reason 的 durable retry；
- Admin usage pricing 发布使用 immutable revision、Entitlement command receipt 和 audit event；quote/hold 会锁定发布时的 pricing revision，不会被后续价格修改重算；
- 平台统一 `/metrics` Prometheus 面，API/Payment Worker/Credit Sweeper 分别暴露进程、HTTP、outbox、dead-letter、lease 和 pending-age 指标，复用 `prom-client`，指标故障 fail-open；
- unit test、真实 PostgreSQL schema integration test、真实 Redis integration test（需显式启用依赖环境）。

## Bounded contexts

- **Payment**：checkout、provider account、provider event inbox、settlement、subscription period、reversal；
  dispute/chargeback 保留为后续 provider dispute fact 扩展，不在 V1 伪造接口。
- **Entitlement/Credit**：catalog、acquisition、fulfillment、subscription term、credit grant、hold、journal、metering。

两个上下文共享仓库生命周期，但不共享业务 repository、表 owner 或事务边界。

## API surfaces

- User / Storefront
- Admin / Operations
- Internal Service
- Provider Webhook

## 目录与 API 版本

首发 API 统一使用 `/v1`。版本目录只放在传输层：`contract/openapi/v1/`、`src/interfaces/http/v1/` 和
`src/interfaces/admin/v1/`；`src/application`、`src/domain`、`src/ports`、PostgreSQL schema 与 Redis key 不按版本复制。
当前不创建 `v2` 目录、不注册 v2 路由、不做双版本兼容。

Operational endpoints follow the platform convention: `GET /healthz` is liveness, `GET /readyz` checks the
configured PostgreSQL and Redis dependencies, and `GET /metrics` exposes Prometheus process metrics.

机器可读目标契约的路径为 `contract/openapi/v1/openapi.yaml`；当前探索实现的 OpenAPI 文件
[`contract/openapi/billing-v1.yaml`](contract/openapi/billing-v1.yaml) 仅作基线，重建时直接生成 v1 目录契约。
设计基线：[`../docs/kokoro-handbook/technical/31-billing-subrepository-architecture.md`](../docs/kokoro-handbook/technical/31-billing-subrepository-architecture.md)。
Provider event worker 与上线门禁：[`../docs/kokoro-handbook/technical/billing-event-processing.md`](../docs/kokoro-handbook/technical/billing-event-processing.md)。
实现闭环证据：[`../docs/kokoro-handbook/technical/billing-closure-evidence.md`](../docs/kokoro-handbook/technical/billing-closure-evidence.md)。

## 技术底座

Node.js 22 + TypeScript；PostgreSQL 16 是最终业务事实；应用使用 PostgreSQL pool，每个事务独占一个物理 session；Redis 做短 TTL 幂等快速路径、sweep leader lease、缓存和异步协调，边缘层负责通用限流，Redis 绝不承担余额或账务事实。

## 实现门禁

1. 先落 PostgreSQL numbered migrations、owner inventory、receipt/outbox。
2. 先完成 Entitlement/Credit 的 grant/hold/journal/settle 不变量，再接 Payment settlement。
3. webhook 先 inbox；跨上下文只走 application port + outbox。
4. 通过 lint、typecheck/build、目标 SQL/OpenAPI、真实 PostgreSQL/Redis integration、contract、architecture、reconciliation tests 后，才进入上线准备；
   当前不存在切换 writer、停写或历史数据迁移步骤。

## 本地验证

```bash
pnpm verify
DATABASE_URL=TARGET pnpm db:migrate
DATABASE_URL=TARGET pnpm test:integration
REDIS_TEST_URL=TARGET pnpm exec vitest run test/integration/redis-idempotency-hint.test.ts test/integration/redis-lease.test.ts --no-file-parallelism
DATABASE_URL=TARGET REDIS_URL=TARGET pnpm internal:expire-credit-holds
```

历史 Credit/Payment 导入器不属于本仓运行时或 clean-build 入口；迁移考古只使用 Root 外部归档材料，
不把旧数据库连接、旧表名或双写逻辑带回 Billing。

首次部署的套餐和用量价格通过受保护的 bootstrap 命令写入，不再调用旧 Credit/Payment seed：

```bash
ALLOW_BILLING_SEED=true \
BILLING_SEED_JSON='{"tenantId":"tenant-1","effectiveFrom":"2026-01-01T00:00:00.000Z","plans":[],"usagePrices":[]}' \
DATABASE_URL=TARGET pnpm db:seed
```

同一份 JSON 会使用稳定的内容摘要和 PostgreSQL command receipt 幂等重放；生产只允许部署编排显式传入
`ALLOW_BILLING_SEED=true`，不能把 bootstrap 当作普通运行时写接口。多站点 provider webhook 必须在同一份 seed 中
登记 `providerAccounts`，生产按 provider account 映射 tenant；新建支付 metadata 使用 `tenantId`，历史 payload 的 `siteId` 只做一致性校验，不接受 payload 自带标识作为租户授权：

```json
{"tenantId":"tenant-1","providerAccounts":[{"provider":"stripe","externalAccountRef":"acct_TARGET","status":"active"}]}
```

生产镜像的 API、migration、worker job 使用已编译入口（runtime 镜像不携带 `tsx`）：
`node dist/src/main.js`、
`node dist/scripts/apply-migrations.js`、`node dist/scripts/process-payment-events.js`、
`node dist/scripts/expire-credit-holds.js`。本地 `pnpm internal:expire-credit-holds` 使用 `tsx` 便于开发，
由 Scheduler 负责触发，不作为常驻 Billing worker。

本地入口：`BILLING_AUTH_MODE=header-fixture DATABASE_URL=TARGET pnpm dev`。该入口明确是本地 fixture
认证适配器；生产入口必须使用 `BILLING_AUTH_MODE=jwks`，通过 `jose` 的 Remote JWKS 验证 IAM
签发的 RS256 Bearer JWT，并强制校验 `iss`、`exp`、`sub`、`tenant_id` 以及 `x-kokoro-tenant-id` 一致性。
Internal service 仍使用 service secret；`/v1/commerce/catalog` 与 `/v1/billing/checkout` 还接受
仅限 `web-bff` 的 service-auth：必须同时校验 `x-kokoro-service`、`x-kokoro-internal-secret`、
`Authorization: Bearer` 服务凭据和 `x-kokoro-tenant-id`，checkout 另校验 `x-kokoro-subject`。
`BILLING_BFF_SERVICE_TOKEN` 可独立配置 bearer，缺省使用 `INTERNAL_SERVICE_SECRET` 以兼容当前 BFF
出站格式；Admin 只接受独立的 operator proxy secret 和 `billing.admin` 角色。租户上下文统一采用平台
标准 `x-kokoro-tenant-id`，不把 header fixture 或旧的 `x-kokoro-site` 当成生产认证方案。
