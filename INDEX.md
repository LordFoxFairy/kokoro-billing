# kokoro-billing 仓库地图

本文描述当前代码与事实边界。进度与缺口见 [`docs/CURRENT.md`](docs/CURRENT.md)，字段级 wire contract 见
[`contract/openapi/v1/openapi.yaml`](contract/openapi/v1/openapi.yaml)。

这是Fastify/pg现状地图，不是新实现的四层模板；Nest/Prisma目标与切片见
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)及ADR-0003。

## 事实源与入口

| 路径 | 职责 | 约束 |
|---|---|---|
| `contract/openapi/v1/openapi.yaml` | Billing HTTP v1 的 machine source | owner-authored；先改 contract，再改实现/消费者 |
| `database/schema.sql` | 35 张 Billing 表的 canonical Schema | PostgreSQL 16；空库安装；无 FK/REFERENCES |
| `.node-version` / `package.json` / `pnpm-lock.yaml` | 固定Node24.20.0、pnpm与精确依赖 | 本地、CI和镜像版本由toolchain治理测试核对 |
| `test/architecture/toolchain.test.ts` | 工具链配置正反例 | manifest/lock、CI实际门、Docker FROM、engineStrict；不代替运行验收 |
| `src/main.ts` | API 进程入口 | 只调用 composition root，不包含业务规则 |
| `src/bootstrap/create-billing-runtime.ts` | 组合根 | 装配 config、PostgreSQL、Redis、provider、application 与 HTTP |
| `src/interfaces/http/server.ts` | Fastify transport | Zod 边界校验、身份入口、snake_case/envelope/error 映射 |
| `scripts/apply-schema.ts` | Schema job | advisory lock + blank-database guard + 单事务安装 |
| `scripts/canonical-schema.ts` | 离线安装用例 | public-only、全用户namespace非空保护、受控连接错误/超时与事务回滚；不做B5全量drift |
| `scripts/verify-schema.ts` | 全量catalog验证CLI | 目标只读、显式SCHEMA_ADMIN_URL、同实例临时参照、差异exit1 |
| `scripts/schema-catalog.ts` / `schema-catalog.types.ts` | catalog读取与快照类型 | canonical SQL生成参照，不维护第二人工Schema |
| `scripts/schema-verification.ts` / `schema-database-session.ts` / `schema-verification.error.ts` | 验证编排、连接生命周期、安全错误 | 各文件单一职责，原错/清理错保留，诊断不泄露凭据 |
| `scripts/process-payment-events.ts` | Payment event worker | PostgreSQL row lease、重试、dead-letter 与 worker metrics |
| `scripts/process-execution-events.ts` | Execution event batch | 顺序处理 received inbox event |
| `scripts/expire-credit-holds.ts` | Expiry worker | 显式 tenant/batch identity；Redis lease 协调；PostgreSQL receipt/事务维护事实 |

## 依赖方向

```text
interfaces -> application -> domain
bootstrap  -> application + concrete infrastructure + interfaces
infrastructure -> application/domain ports
domain -> no HTTP/PostgreSQL/Redis/provider SDK
```

当前 application repository ports 位于各 context 的 `ports/`；PostgreSQL 实现位于
`src/infrastructure/postgres/repositories/<context>/`。`src/application/ports/transaction.ts` 是显式事务 port。

## Bounded contexts

| Context | Application | Infrastructure | 主要事实 |
|---|---|---|---|
| Checkout/Catalog | `src/application/checkout/` | `.../repositories/checkout/`、`providers/stripe-checkout-provider.ts` | offer、revision、checkout、hosted session |
| Payment | `src/application/payment/` | `.../repositories/payment/`、`providers/payment/` | provider account/event、settlement、outbox |
| Refund | `src/application/refund/` | `.../repositories/refund/` | reversal 与 fulfillment reversal |
| Subscription | `src/application/subscription/` | `.../repositories/subscription/` | provider subscription、period、entitlement term |
| Credit | `src/application/credit/` | `.../repositories/credit/` | account、grant、hold allocation、journal、redeem |
| Metering | `src/application/metering/` | `.../repositories/metering/` | pricing、usage event/settlement、billing admission |
| Reconcile | `src/application/reconcile/` | `.../repositories/reconcile/` | stats 与 drift report；当前未装配独立 runtime entrypoint |

`src/domain/payment/services/billing-state-machine.ts` 当前承载 PaymentCollection、PaymentAttempt 与 Admission 的纯状态迁移规则。

## 横切基础设施

- `src/config/`：环境变量解析、auth/provider/timeout 启动约束。
- `src/infrastructure/auth/`：JWT、service/BFF/admin context 验证。
- `src/infrastructure/postgres/`：pool、request/worker-scoped transaction、JSON 解析、outbox worker。
- `src/infrastructure/redis/`：非权威 idempotency key-presence marker、lease、deadline/retry policy；不接收 body/digest，不判定 replay/conflict。
- `src/infrastructure/metrics.ts`、`worker-metrics.ts`：HTTP 与 worker Prometheus metrics。
- `src/infrastructure/providers/`：Stripe/Alipay/WeChat webhook adapter 与 Stripe checkout adapter。

## 测试地图

| 目录 | 当前用途 |
|---|---|
| `test/unit/` | 状态机、auth、provider、timeout、redeem 与纯分配规则 |
| `test/http/` | v1 route、envelope、身份、snake_case 与旧路径拒绝 |
| `test/integration/` | PostgreSQL/Redis repository、事务、Schema、worker 与对账；需要真实 fixture |
| `test/architecture/` | 分层、SQL 边界、strictness、文档、contract metadata、CI/供应链与 clean-slate 门禁 |
| `test/doubles/` | 测试专用 provider double；生产 `src/` 不含 fake/in-memory provider |

`test/integration/schema-installation.test.ts`的21个用例分别创建独占临时database，覆盖安装范围、对象保留、权限、并发、
DDL失败、backend终止和客户端deadline；仅该fixture的管理连接需要CREATEDB/测试扩展权限，不将其授予生产Billing角色。

## 交付与文档

- `.github/workflows/ci.yml`：依赖安装、Trivy、Schema、真实 integration、repository verify 与 image build。
- `.github/workflows/release-image.yml`：验证、candidate build/scan/smoke、SBOM、provenance、digest 签名。
- `Dockerfile`：digest-pinned Node 22、多阶段构建、non-root runtime、HEALTHCHECK。
- [`docs/INDEX.md`](docs/INDEX.md)：当前文档入口。
- [`docs/ADR/`](docs/ADR/)：本仓仍有效的架构决策；Root handbook 只作背景材料。

## Prisma 生成治理（B6a）

- `prisma.config.ts`：固定生成schema入口，离线Client生成不读取应用数据库。
- `scripts/canonical-reference.ts`：B5 catalog与Prisma共用的独占参照库生命周期。
- `scripts/prisma-generation.*`、`scripts/prisma-process.ts`：固定工具编排、元数据与有界进程组。
- `scripts/prisma-artifacts.ts`：全文件比较、独占发布与回滚；`prisma-check.ts`/`prisma-refresh.ts`为安全CLI边界。
- `database/generated/`：只读生成schema/provenance；`src/generated/prisma/`为Git忽略的Client。
- `test/{unit,integration,architecture}/prisma-generation.test.ts`：生成一致性、隔离真实Client、故障与边界。


## TypeScript依赖治理入口（B7c）

- test/architecture/typescript-dependency-project.ts：真实tsconfig与手写src扫描。
- test/architecture/typescript-dependency-graph.ts / typescript-dependency.types.ts：TS6 AST、模块解析、值/类型图和静态导出来源。
- test/architecture/billing-dependency-policy.ts：feature/public/Controller边界及B8精确过渡债；不是业务运行模块。
- test/architecture/typescript-dependency-graph.test.ts：同分析管线的正反例；ownership.test.ts与prisma-generation.test.ts在真实项目执行。
