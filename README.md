# kokoro-billing

Kokoro 的商业账务子仓库，统一承载 Payment、Subscription、Credit、Entitlement 和 Metering。
Credit 不拆成独立仓库；Billing 是余额、授权、扣费和支付事实的唯一 owner。

## 设计边界

- **Payment**：checkout、provider account、provider event inbox、settlement、subscription period 和 reversal。
- **Entitlement/Credit**：catalog、acquisition、fulfillment、grant、hold、journal 和 usage settlement。
- 两个 bounded context 共享进程，但不共享 repository、表 owner 或事务边界。
- PostgreSQL 是账务事实；Redis 只用于短 TTL 幂等提示和异步协调，不承载余额、账本或支付状态。
- Scheduler 只调用 Billing 的过期命令，不连接 Billing 数据库；Agent/Model 通过 admission、capture、release 和 execution event 接入。

## v1 HTTP 契约

唯一机器可读契约是 [`contract/openapi/v1/openapi.yaml`](contract/openapi/v1/openapi.yaml)。HTTP 只暴露以下版本化资源：

| Surface | Routes |
|---|---|
| Operations | `GET /healthz`、`GET /readyz`、`GET /metrics` |
| User/BFF | `GET /v1/commerce/catalog`、`GET /v1/billing/me/credit-account`、`GET /v1/billing/me/credit-ledger`、`GET /v1/billing/me/subscriptions`、`POST /v1/billing/checkout` |
| Internal execution | `POST /v1/internal/entitlement/admissions`、`.../{admissionId}/capture`、`.../{admissionId}/release`、`POST /v1/internal/billing/execution-events` |
| Internal payment | `POST /v1/internal/payment/settlements/accept`、`POST /v1/internal/payment/refunds/accept` |
| Scheduler command | `POST /v1/internal/commands/expire-credit-holds` |
| Provider | `POST /v1/webhooks/payment/{provider}` |
| Admin | `POST /v1/admin/billing/refunds` |

所有 mutation 要求 `Idempotency-Key`。所有 v1 JSON 响应使用 `{data, meta}` 或 `{error, meta}`，`meta.request_id` 是唯一请求追踪字段，外部 JSON 使用 snake_case。租户只来自受信 `X-Kokoro-Tenant-Id` 上下文，不从 body、query、provider payload 或 caller-selected account 取值。

旧的无版本 API、camelCase HTTP payload、旧 `tenant_id` header 和兼容 route alias 已移除；新增接口必须先更新 OpenAPI，再实现 route parity 和 contract test，不再新增第二套兼容协议。

## 运行时组合

唯一服务入口是 [`src/main.ts`](src/main.ts)。它只装配当前 v1 HTTP surface 所需的 application services；Credit redeem、catalog admin、usage pricing admin、reconciliation 和 provider-event admin 保留为 Billing 内部业务能力，不能通过未登记的旧 HTTP 路径暴露。

生产使用已编译入口：

```bash
node dist/src/main.js
node dist/scripts/apply-schema.js
node dist/scripts/process-payment-events.js
node dist/scripts/expire-credit-holds.js
```

本地开发入口：

```bash
BILLING_AUTH_MODE=internal-header DATABASE_URL=TARGET REDIS_URL=TARGET pnpm dev
```

生产必须使用 `BILLING_AUTH_MODE=jwks`、IAM 签发的 RS256 JWT、独立 internal service secret 和 operator proxy secret。Web BFF 的 catalog/checkout owner call 还必须通过 `web-bff` service-auth；浏览器不直连 internal、provider 或 admin owner route。

## 质量门禁

```bash
pnpm verify
```

该命令依次执行 lint、typecheck、build、SQL 命名检查、OpenAPI route parity 和 Vitest。真实 PostgreSQL/Redis 验证需显式提供 fixture：

```bash
DATABASE_URL=TARGET pnpm db:apply-schema
DATABASE_URL=TARGET pnpm test:integration
REDIS_TEST_URL=TARGET pnpm exec vitest run test/integration/redis-idempotency-hint.test.ts test/integration/redis-lease.test.ts --no-file-parallelism
```

## 相关文档

- [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)：v1 wire contract 与认证边界。
- [`docs/BFF_INTEGRATION.md`](docs/BFF_INTEGRATION.md)：BFF owner call 要求。
- [`../docs/kokoro-handbook/technical/50-billing-commerce-rearchitecture.md`](../docs/kokoro-handbook/technical/50-billing-commerce-rearchitecture.md)：bounded context 与数据 owner 设计。
