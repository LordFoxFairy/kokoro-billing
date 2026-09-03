# Billing API Contract

Canonical machine-readable contract: [`../contract/openapi/v1/openapi.yaml`](../contract/openapi/v1/openapi.yaml).

## v1 surfaces

| Surface | Routes | Identity |
|---|---|---|
| User/BFF | `/v1/commerce/catalog`, `/v1/billing/me/credit-account`, `/v1/billing/me/credit-ledger`, `/v1/billing/me/subscriptions`, `/v1/billing/checkout` | User routes: IAM JWT + tenant match; catalog/checkout also accept the trusted `web-bff` service-auth alternative |
| Internal execution | `/v1/internal/entitlement/admissions`, `/capture`, `/release`, `/v1/internal/billing/execution-events` | registered Agent/Model/Studio service |
| Internal payment | `/v1/internal/payment/settlements/accept`, `/v1/internal/payment/refunds/accept` | Payment worker service |
| Scheduler command | `/v1/internal/commands/expire-credit-holds` | Scheduler service only |
| Provider | `/v1/webhooks/payment/{provider}` | provider signature + account mapping |
| Admin | `/v1/admin/billing/refunds` | operator proxy + billing admin role |

Mutations require `Idempotency-Key`. Tenant comes from `X-Kokoro-Tenant-Id`; it is never selected from request JSON, query parameters, provider payload, `account_id`, or runtime namespace. Monetary and credit values are decimal strings. Unknown execution outcomes retain an active hold and are reconciled later.

Internal execution events trust only the authenticated caller service identity, internal credential and tenant context. Their JSON body contains event identity, execution/invocation identity, occurrence time, receipt schema version and optional receipt; it has no message-signature field. Provider webhooks remain a separate external trust boundary with provider-specific signature verification before persistence.

### Storefront service-auth alternative

`GET /v1/commerce/catalog` and `POST /v1/billing/checkout` keep the public IAM JWT path and additionally expose the owner route to the registered Web BFF. Billing selects the service path whenever an internal marker is present; it never falls back to user authentication after a failed BFF attempt.

The BFF request must contain all of the following:

```text
X-Kokoro-Service: web-bff
X-Kokoro-Internal-Secret: INTERNAL_SERVICE_SECRET
Authorization: Bearer BFF_SERVICE_TOKEN
X-Kokoro-Tenant-Id: TENANT_ID
```

Checkout also requires `X-Kokoro-Subject`, which is the trusted subject resolved by the BFF. The catalog only needs the tenant context. `BILLING_BFF_SERVICE_TOKEN` configures the required, independent bearer. A wrong service, forged credential, missing required header, invalid tenant, or invalid checkout subject returns a v1 error with `billing.service_auth_failed` or `billing.service_subject_required` and HTTP `403`.

The service-auth alternative is not enabled for `/v1/billing/me/*`; those routes remain user JWT-only.

所有列表接口使用 opaque `cursor` 与 `next_cursor`，游标绑定 tenant、资源和 filter；损坏或越界游标返回统一的
`billing.invalid_cursor`。

Success envelope:

```json
{"data": {}, "meta": {"request_id": "req_TARGET"}}
```

所有 `/v1` 成功响应只包含 `data` 与 `meta` 两个顶层字段；`requestId` 不再作为 v1 顶层字段返回。v1 `data` 内的公开字段统一使用 snake_case，例如 catalog 使用 `offers[].amount_minor`、`offers[].credit_micros`、`offers[].billing_interval`，checkout 请求使用 `offer_revision_id`、`amount_minor` 与 `quote_snapshot`。

`quote_snapshot` 至少包含 `key` 与 `credit_micros`，可包含 `name` 及其他报价快照字段。传输层将 snake_case 快照适配到既有 CheckoutService 所需的 `key`、`creditMicros`、`name` 等内部字段后再调用服务。

非 `/v1` 路径不属于 Billing API；旧 route alias 已删除。任何新资源必须先进入本文件和
`contract/openapi/v1/openapi.yaml`，再实现对应的 handler 与 parity test。

Error envelope:

```json
{"error": {"code": "billing.invalid_request", "message": "...", "retryable": false, "details": {}}, "meta": {"request_id": "req_TARGET"}}
```

Service-auth error codes:

```text
billing.service_auth_failed       403
billing.service_subject_required  403
```
