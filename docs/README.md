# kokoro-billing 实现说明

本仓是 Billing 的模块化单体，Credit/ledger/redeem 是 Billing 内部的 entitlement 模块；不存在独立 Credit writer。唯一运行入口是 `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/src/main.ts`。

## 边界与调用

- Web BFF 只代理 User 路由，透传 `X-Kokoro-Tenant-Id`、`X-Kokoro-Request-Id` 和用户认证上下文；浏览器不直连内部 admission、payment 或 admin 路由。
- Agent/Model/Studio 仅调用 `/v1/internal/entitlement/admissions` 及其 capture/release 子资源，并使用同一 `invocation_id` 重试。
- Payment worker 只调用 `/v1/internal/payment/settlements/accept` 或 `/v1/internal/payment/refunds/accept`。
- Scheduler 不连接 Billing 数据库；只以 service identity 调用 `/v1/internal/commands/expire-credit-holds`。过期释放仍由 PostgreSQL 行锁和事实表完成。
- Provider 通过 `/v1/webhooks/payment/{provider}` 进入签名校验、inbox、去重和异步处理链路。

所有 v1 JSON 成功响应严格使用 `{data, meta: {request_id}}`，不再输出顶层 `requestId`；错误包含 `error.request_id`、`retryable`、`details` 和同级 `meta.request_id`。`quote_snapshot` 使用 snake_case wire 字段（至少 `key`、`credit_micros`，可带 `name` 等），HTTP adapter 在传给既有 CheckoutService 前转换为其 camelCase DTO。非 `/v1` 旧路径继续保留原有顶层 `requestId` 和 camelCase payload，以维持兼容。

## 账务状态

`src/domain/billing-state-machine.ts` 固化 PaymentCollection、PaymentAttempt 和 BillingAdmission 的合法前向迁移。Admission 的 `unknown` 保留 hold，只有受信 accepted receipt 才 capture，明确 failed/rejected 才 release。

`entitlement_billing_command_receipt` 是 admission/capture/release 的 PostgreSQL 最终幂等事实；Redis 只做短 TTL 冲突提示。`entitlement_execution_event` 先落 inbox，再由 worker 调用同一 application service，事件到达不会直接伪造 capture。

## 本地 BFF fixture

```bash
cd /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing
BILLING_AUTH_MODE=header-fixture DATABASE_URL=TARGET pnpm dev
```

fixture 只使用本地假身份；生产必须使用 JWKS 用户认证、独立 internal service secret 和独立 operator proxy secret。示例中的 `TARGET`、`HOST`、`PORT`、`TOKEN` 均为占位符。

## 验收命令

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm sql:check
pnpm contract:check
```

可选真实依赖验证：

```bash
DATABASE_URL=TARGET pnpm db:migrate
DATABASE_URL=TARGET pnpm test:integration
REDIS_TEST_URL=TARGET pnpm exec vitest run test/integration/redis-idempotency-hint.test.ts test/integration/redis-lease.test.ts --no-file-parallelism
```

最近本地 fixture 验收：`61 passed / 52 skipped`；typecheck、lint、build、SQL 命名门禁和 OpenAPI route parity（48 routes）均通过。集成测试在未提供 PostgreSQL/Redis fixture 时按项目约定跳过，不把跳过结果当作真实依赖验收。

## 当前风险与未完成项

- 现有旧 V1 物理表仍用于兼容本地探索测试；新 admission/execution 事实已使用 `tenant_id`，后续 clean database 批次应一次性收敛其余旧表和内部 camelCase adapter，不做双写。
- `entitlement_execution_event.signature` 的生产验签器需要与 GA/Studio 的 service-signing registry 接入；当前路由先要求受信 service identity，provider webhook 仍走 provider-specific signature verifier。
- PostgreSQL/Redis integration 需要显式提供本地 fixture；没有真实依赖时只报告 unit/HTTP/架构门禁结果。
