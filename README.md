# kokoro-billing

Kokoro 的 Billing 事实 owner。仓库拥有 Payment、Subscription、Checkout、Refund、Credit、Ledger、Metering、
Reconcile 与 Billing command receipt；不拥有 Tenant、Identity、Agent Run、ScheduledTask 或对象存储事实。

> 当前状态、已验证能力与缺口见 [`docs/CURRENT.md`](docs/CURRENT.md)。本文是启动入口，不把目标架构或本地测试结果
> 表述为生产证据。

当前规范化分支的[任务板](docs/IMPLEMENTATION_PLAN.md)与[ADR-0003](docs/ADR/0003-nestjs-prisma-sql-first-alignment.md)
记录Nest/Prisma目标与分阶段验收；唯一正常入口现使用 canonical Nest module graph，当前仅个人余额/流水及三项 probe，完整 Billing 业务与收费仍待验收。

## 边界

- PostgreSQL 是支付、余额、账本、幂等 receipt、inbox/outbox 与对账事实源。
- Redis 仅保存可丢失的短 TTL idempotency key-presence marker，并承担 expiry worker 的 best-effort lease；它不保存或比较请求
  body/digest，不决定 replay、冲突、终态或结果。Redis 在启动或运行中丢失时，API 保持 ready（报告 `redis=degraded`），expiry
  继续依靠 PostgreSQL 执行；规范化 command 与 PostgreSQL durable receipt/owner fact 是唯一裁决。
- Browser 通过 Web/BFF 调用；BFF、Agent、Model、Studio、Payment worker 与 Scheduler 只能使用 Billing 拥有的协议，
  不读取本仓数据库。
- Credit 是 Billing 内部 bounded context，不存在独立 Credit writer。
- 唯一 canonical Schema 是 [`database/schema.sql`](database/schema.sql)；installer 只要求同一应用数据库中的
  `kokoro_billing` owner schema 为空，不扫描或读取相邻 owner schema，也不维护 migration 链。

## 正常开发启动

要求 `.node-version` 的 Node24.20.0 和 pnpm11.25.0。使用 `.env.example` 的显式 normal 配置；三个 service credential 必须各自独立、至少32个 printable 字符。JWKS/issuer/audience 指向正式 IAM profile；正常入口只接受 jwks，不提供 internal-header fallback。

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
# 按本地环境准备 .env.local；不将凭据提交到仓库。
set -a; source .env.local; set +a
```

复用共享 PostgreSQL 应用数据库；Billing 只拥有 `kokoro_billing`。`DATABASE_URL` 必须恰有一个 `schema=kokoro_billing` 且没有 options。只在该 owner schema 为空时首次执行 installer，已有 schema 的正常启动不执行 installer、不迁移或重置数据：

```bash
pnpm db:apply-schema # 仅首次空 owner schema
pnpm dev
# 或构建后使用同一入口图：pnpm build && pnpm start
```

`GET /healthz` 为 liveness，`GET /readyz` 只验证 canonical PostgreSQL，`GET /metrics` 为现 Prometheus registry。初始 graph 不装 Redis/provider，不需要支付凭据、赠送、价格或 Redis 配置；健康成功不表示业务或收费成功。

当前只注册 `/v2/billing/me/credit-account` 和 `/v2/billing/me/credit-ledger` 两项本人 GET。账户不存在返回404，不创建或假报零余额。受信 BFF 同时携带 `web-bff`、internal secret、独立 BFF bearer 及 canonical `u1` tenant/subject header；浏览器不持有这些凭据。BFF 对应配置是 `KOKORO_BILLING_BASE_URL`、`KOKORO_INTERNAL_SECRET_BFF`、`KOKORO_BILLING_BFF_SERVICE_TOKEN`。

其余19项 v2 operation 尚未接入，旧 v1 transport 已删除；catalog/subscription/支付/结算等路由不代理旧服务、不注册假 handler。worker、seed、收费全链仍为后继。

结构验收使用 `pnpm db:verify-schema`，另行提供只供工具使用、可创建本轮参照库的 `SCHEMA_ADMIN_URL`；不进入应用配置。真实源码/dist进程测试见 `test/integration/billing-runtime.test.ts`，由拥有隔离资源的 Root执行；纯测试与健康检查不能替代它。

## 契约

Canonical machine-readable source 是
[`contract/openapi/v1/openapi.yaml`](contract/openapi/v1/openapi.yaml)，治理与 consumer 流程见
[`contract/README.md`](contract/README.md)。Billing 的全部 HTTP operation 都是 `internal-owner`；即使 storefront route
可由受信 BFF 代调用，也不是 Root Developer API 门户的 `public` Product API。

v2 target artifact `contract/openapi/v2/openapi.yaml` 仍描述24项 operation；当前运行仅注册3 probes与2本人读取。v1 artifact 作为历史契约治理保留，不是可调用的兼容入口；contract检查不再读取已删除旧server做v1 runtime parity。实际路由和源码/dist生命周期单独验收。

## 运行单元与尚未切换的旧业务工具

| 单元 | 源码入口 | 当前职责 |
|---|---|---|
| Billing API | `src/main.ts` | Nest/FastifyAdapter canonical graph、PostgreSQL、两本人GET与三probe |
| Payment event worker | `scripts/process-payment-events.ts` | 领取 `payment_outbox`，处理 provider event，重试或 dead-letter |
| Execution event batch | `scripts/process-execution-events.ts` | 处理 `entitlement_execution_event.status=received` |
| Credit expiry worker | `scripts/expire-credit-holds.ts` | tenant-scoped batch；Redis lease 只协调，PostgreSQL receipt/事务决定结果 |
| Schema installer | `scripts/apply-schema.ts` | 在空 PostgreSQL database 安装 canonical Schema |

构建后的入口位于 `dist/src/` 与 `dist/scripts/`，`dist/` 不是可编辑事实源。

## 质量门禁

手写代码使用仓内固定的 Prettier，`pnpm format` 写入格式，`pnpm format:check` 只检查；后者是 `verify` 的第一门。
SQL、OpenAPI、Prisma 生成物和 lockfile 由各自工具治理，不混入格式重排。

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm sql:check
pnpm contract:check
pnpm verify
```

真实依赖验证必须显式连接 PostgreSQL/Redis；被跳过的 integration test 不算依赖验收：

```bash
DATABASE_URL=TARGET REDIS_TEST_URL=redis://HOST:PORT/4 pnpm test:integration
```

完整验收矩阵、Root 静态审计切片与结果判定见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。

## 导航

- [`INDEX.md`](INDEX.md)：代码、contract、Schema、测试和运行入口地图。
- [`docs/INDEX.md`](docs/INDEX.md)：当前有效文档的阅读顺序。
- [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md)：依赖方向、事务与状态机。
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)：表 owner、不变量、关系与 retention。
- [`docs/SECURITY.md`](docs/SECURITY.md) / [`docs/RELIABILITY.md`](docs/RELIABILITY.md)：信任边界与故障语义。
- [`docs/SLO.md`](docs/SLO.md) / [`docs/RUNBOOK.md`](docs/RUNBOOK.md)：目标、告警与处置。


### Prisma 生成入口

B6a已提供SQL-first只读生成链，生产仍使用原pg实现。`pnpm prisma:generate`从已提交schema离线生成Client，
`typecheck`、`build`、`test`和`test:integration`已显式调用它。需要CREATEDB管理连接的`prisma:refresh`/`prisma:check`
只使用本轮临时参照库；check不覆盖差异，操作顺序和残留锁处理见[数据库说明](database/README.md)。
