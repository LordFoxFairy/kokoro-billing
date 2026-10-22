# kokoro-billing

Kokoro 的 Billing 事实 owner。仓库拥有 Payment、Subscription、Checkout、Refund、Credit、Ledger、Metering、
Reconcile 与 Billing command receipt；不拥有 Tenant、Identity、Agent Run、ScheduledTask 或对象存储事实。

> 当前状态、已验证能力与缺口见 [`docs/CURRENT.md`](docs/CURRENT.md)。本文是启动入口，不把目标架构或本地测试结果
> 表述为生产证据。

当前规范化分支的[任务板](docs/IMPLEMENTATION_PLAN.md)与[ADR-0003](docs/ADR/0003-nestjs-prisma-sql-first-alignment.md)
记录Nest/Prisma目标与分阶段验收；唯一入口使用canonical Nest module graph。已交付目录、本人余额/流水、无感零账户初始化及三项probe；本地候选新增正式非现金管理员发放，相关owner验收已过但正常后台消费者尚待。完整Agent资金授权、实际用量结算与收费仍待接线，不以源码候选冒称正常生效。

本地计价候选已完成正式管理三HTTP操作、policy2单次整数预算和rate2精确System修订绑定；exp7新增BFF预算Admission创建／原命令恢复和本人当前状态读取；完整验证与真实PG证据见CURRENT首节。消费者及Agent逐attempt资金接线仍需完成，正常环境未因本片变化。

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

当前默认业务图注册 `/v1/commerce/catalog`、本人账户／流水 GET、本人账户初始化 PUT、
后台 `credit-grants` POST，以及现有计价修订 GET／两项发布 POST；另有三项 probe。
受信 BFF 使用 `web-bff`、internal secret、独立 BFF bearer 及 canonical `u1` tenant／subject；
后台维护另外要求独立 operator proxy 身份。浏览器不持有这些机器凭据。

支付、provider 执行和实际使用结算仍未在此 API 图挂载；不注册假 handler、不代理旧 transport。
预算 Admission 的显式装配与接口见下节；创建预算不等于已执行模型或已扣分。

结构验收使用 `pnpm db:verify-schema`，另行提供只供工具使用、可创建本轮参照库的 `SCHEMA_ADMIN_URL`；不进入应用配置。真实源码/dist进程测试见 `test/integration/billing-runtime.test.ts`，由拥有隔离资源的 Root执行；纯测试与健康检查不能替代它。

## 显式预算 Admission HTTP

默认不注册此片两条路由。设置 `BILLING_MODEL_ADMISSION_ENABLED=true` 时，必须同时配置
`BILLING_AGENT_BASE_URL`／`BILLING_AGENT_READER_TOKEN` 和
`BILLING_IAM_BASE_URL`／`BILLING_IAM_AUTHORIZATION_TOKEN`；两个地址仅接受 origin。
peer 单次读取各 2 秒、零重试；`BILLING_MODEL_ADMISSION_DEADLINE_MS` 默认 10000，必须为正整数且不超 2147483647。
设置错误时启动失败；凭据不写日志或回传。原默认图不因这些变量的存在而隐式启用。

- `POST /v1/internal/billing/admissions`：完整 BFF 机器身份＋u1 tenant／subject，
  独立消费 token header、原命令 key 及六项 prepared 绑定；先正式读 Agent 与 IAM，再原子预占配置的整次预算。
- `GET /v1/internal/billing/admissions/{admission_id}`：同一 BFF／本人范围的 RR 只读当前状态；
  不要求消费 token、不触达 Agent／IAM、不绑定新 key。
- POST 的永久回执始终返回原始 `held` 创建结果；当前状态只由 GET 表示。
  503／ACK 不明只用原命令恢复，不换 body／attempt 自动重发。预算 hold 无 TTL；不猜价、补零或自动派发。

此开关不接入 provider 执行、capture／release 或真实使用扣分。正常环境激活仍需受保护的 Schema 配对与 App 正式消费授权生命周期；本片只在自有隔离资源验收。

## 契约

Canonical machine-readable source 是
[`contract/openapi/v1/openapi.yaml`](contract/openapi/v1/openapi.yaml)，治理与 consumer 流程见
[`contract/README.md`](contract/README.md)。Billing 的全部 HTTP operation 都是 `internal-owner`；即使 storefront route
可由受信 BFF 代调用，也不是 Root Developer API 门户的 `public` Product API。

当前唯一可编辑发布源为上述 v1 canonical（29项 operation／56 schema），仅已装配路由可调用。
`contract/openapi/v2/openapi.yaml` 是既存目标治理材料，不是兼容 transport，也不代表当前可调用操作。
源码／dist 的实际装配与生命周期另行验收。

## 运行单元与尚未切换的旧业务工具

| 单元 | 源码入口 | 当前职责 |
|---|---|---|
| Billing API | `src/main.ts` | Nest/FastifyAdapter canonical graph、PostgreSQL、上述默认业务图与显式预算 Admission |
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
