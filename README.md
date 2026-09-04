# kokoro-billing

Kokoro 的 Billing 事实 owner。仓库拥有 Payment、Subscription、Checkout、Refund、Credit、Ledger、Metering、
Reconcile 与 Billing command receipt；不拥有 Tenant、Identity、Agent Run、ScheduledTask 或对象存储事实。

> 当前状态、已验证能力与缺口见 [`docs/CURRENT.md`](docs/CURRENT.md)。本文是启动入口，不把目标架构或本地测试结果
> 表述为生产证据。

## 边界

- PostgreSQL 是支付、余额、账本、幂等 receipt、inbox/outbox 与对账事实源。
- Redis 仅保存可丢失的短 TTL idempotency key-presence marker，并承担 expiry worker lease；它不保存或比较请求 body/digest，
  不决定 replay、冲突或结果。规范化 command 与 PostgreSQL durable receipt/owner fact 是唯一裁决。
- Browser 通过 Web/BFF 调用；BFF、Agent、Model、Studio、Payment worker 与 Scheduler 只能使用 Billing 拥有的协议，
  不读取本仓数据库。
- Credit 是 Billing 内部 bounded context，不存在独立 Credit writer。
- 唯一 canonical Schema 是 [`database/schema.sql`](database/schema.sql)；V1 只支持空数据库安装，不维护 migration 链。

## 五分钟启动

要求 Node.js 22、`pnpm@11.25.0`，并复用 Root 的 PostgreSQL 与 Redis。Billing 使用独立 PostgreSQL database/schema
和 Redis logical DB `4`。

```bash
cd /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing
pnpm install --frozen-lockfile
cp .env.example .env
```

将 `.env` 中的 `DATABASE_URL`、`REDIS_URL` 和凭据占位符替换为本地 fixture。`db:apply-schema` 会拒绝已有业务表的
database，因此只对 Billing 的空 database 执行：

```bash
set -a; source .env; set +a
pnpm db:apply-schema
pnpm dev
```

默认监听 `127.0.0.1:4245`：

```bash
curl --fail http://127.0.0.1:4245/healthz
curl --fail http://127.0.0.1:4245/readyz
```

`BILLING_AUTH_MODE=internal-header` 只用于本地 fixture；`NODE_ENV=production` 强制使用 `jwks`。

## 契约

Canonical machine-readable source 是
[`contract/openapi/v1/openapi.yaml`](contract/openapi/v1/openapi.yaml)，治理与 consumer 流程见
[`contract/README.md`](contract/README.md)。Billing 的全部 HTTP operation 都是 `internal-owner`；即使 storefront route
可由受信 BFF 代调用，也不是 Root Developer API 门户的 `public` Product API。

当前实现包含 17 个 HTTP operation：3 个运行探针/指标、5 个用户或 BFF surface、4 个 execution/admission surface、
2 个 payment worker surface、1 个 Scheduler command、1 个 provider webhook 和 1 个 admin refund command。
字段级请求/响应以 OpenAPI 为准；人类可读的身份、幂等、错误与分页规则见
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)。

## 运行单元

| 单元 | 源码入口 | 当前职责 |
|---|---|---|
| Billing API | `src/main.ts` | Fastify v1 transport、auth、PostgreSQL/Redis/provider 装配、health/ready/metrics |
| Payment event worker | `scripts/process-payment-events.ts` | 领取 `payment_outbox`，处理 provider event，重试或 dead-letter |
| Execution event batch | `scripts/process-execution-events.ts` | 处理 `entitlement_execution_event.status=received` |
| Credit expiry worker | `scripts/expire-credit-holds.ts` | tenant-scoped batch；Redis lease 只协调，PostgreSQL receipt/事务决定结果 |
| Schema installer | `scripts/apply-schema.ts` | 在空 PostgreSQL database 安装 canonical Schema |

构建后的入口位于 `dist/src/` 与 `dist/scripts/`，`dist/` 不是可编辑事实源。

## 质量门禁

```bash
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
