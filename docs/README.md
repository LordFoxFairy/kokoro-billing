# kokoro-billing 实现说明

本仓是 Billing 的模块化单体，Credit/ledger/redeem 是 Billing 内部的 entitlement 模块；不存在独立 Credit writer。唯一运行入口是 `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/src/main.ts`。

## 边界与调用

- Web BFF 代理 User 路由；catalog/checkout 的 owner 调用使用 Billing 校验的 `web-bff` service-auth（`X-Kokoro-Tenant-Id`、`X-Kokoro-Service`、`X-Kokoro-Internal-Secret`、service bearer，checkout 另带 `X-Kokoro-Subject`），而 `/v1/billing/me/*` 保留 IAM JWT 用户路径。浏览器不直连内部 admission、payment 或 admin 路由。
- Agent/Model/Studio 仅调用 `/v1/internal/entitlement/admissions` 及其 capture/release 子资源，并使用同一 `invocation_id` 重试。
- Payment worker 只调用 `/v1/internal/payment/settlements/accept` 或 `/v1/internal/payment/refunds/accept`。
- Scheduler 不连接 Billing 数据库；只以 service identity 调用 `/v1/internal/commands/expire-credit-holds`。过期释放仍由 PostgreSQL 行锁和事实表完成。
- Provider 通过 `/v1/webhooks/payment/{provider}` 进入签名校验、inbox、去重和异步处理链路。

所有 v1 JSON 成功响应严格使用 `{data, meta: {request_id}}`，不再输出顶层 `requestId`；错误统一使用 `{error: {code, message, retryable, details}, meta: {request_id}}`，request ID 只存在于 `meta`。`quote_snapshot` 使用 snake_case wire 字段（至少 `key`、`credit_micros`，可带 `name` 等），HTTP adapter 在传给既有 CheckoutService 前转换为其 camelCase DTO。非 `/v1` 路径不属于 Billing API，旧 route alias 已删除。

## 账务状态

`src/domain/payment/services/billing-state-machine.ts` 固化 PaymentCollection、PaymentAttempt 和 BillingAdmission 的合法前向状态变化。Admission 的 `unknown` 保留 hold，只有受信 accepted receipt 才 capture，明确 failed/rejected 才 release。

`entitlement_billing_command_receipt` 是 admission/capture/release 的 PostgreSQL 最终幂等事实；Redis 只做短 TTL 冲突提示。`entitlement_execution_event` 先落 inbox，再由 worker 调用同一 application service，事件到达不会直接伪造 capture。
内部 execution event 的唯一信任边界是已认证的 caller service identity、internal secret 与 tenant context；事件体不声明或持久化第二套未验证签名字段。Provider webhook 是独立外部边界，继续执行 provider-specific 签名校验。

## 本地 BFF fixture

```bash
cd /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing
BILLING_AUTH_MODE=internal-header DATABASE_URL=TARGET pnpm dev
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

真实依赖验证（CI/release 必跑）：

```bash
DATABASE_URL=TARGET pnpm db:apply-schema
DATABASE_URL=TARGET pnpm test:integration
REDIS_TEST_URL=TARGET pnpm exec vitest run test/integration/redis-idempotency-hint.test.ts test/integration/redis-lease.test.ts --no-file-parallelism
```

本仓验收以当次命令输出为准；真实集成门禁必须连接 PostgreSQL 与 Redis，跳过结果不作为依赖验收证据。

## 当前风险与未完成项

- 当前 Schema 只用于空数据库安装；所有正式数据事实均直接写入当前表定义，测试替身只存在于 `test/doubles/`。
- PostgreSQL/Redis integration 需要显式提供本地 fixture；没有真实依赖时只报告 unit/HTTP/架构门禁结果。
