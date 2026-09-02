# Billing API Contract

Canonical machine-readable contract: [`../contract/openapi/v1/openapi.yaml`](../contract/openapi/v1/openapi.yaml).

## v1 surfaces

| Surface | Routes | Identity |
|---|---|---|
| User/BFF | `/v1/commerce/catalog`, `/v1/billing/me/credit-account`, `/v1/billing/me/credit-ledger` | IAM user + tenant match |
| Internal execution | `/v1/internal/entitlement/admissions`, `/capture`, `/release`, `/v1/internal/billing/execution-events` | registered Agent/Model/Studio service |
| Internal payment | `/v1/internal/payment/settlements/accept`, `/v1/internal/payment/refunds/accept` | Payment worker service |
| Scheduler command | `/v1/internal/commands/expire-credit-holds` | Scheduler service only |
| Provider | `/v1/webhooks/payment/{provider}` | provider signature + account mapping |

Mutations require `Idempotency-Key`. Tenant comes from `X-Kokoro-Tenant-Id`; it is never selected from request JSON, query parameters, provider payload, `account_id`, or runtime namespace. Monetary and credit values are decimal strings. Unknown execution outcomes retain an active hold and are reconciled later.

所有列表接口使用 opaque `cursor` 与 `next_cursor`，游标绑定 tenant、资源和 filter；损坏或越界游标返回统一的
`billing.invalid_cursor`。

Success envelope:

```json
{"data": {}, "meta": {"request_id": "req_TARGET"}}
```

所有 `/v1` 成功响应只包含 `data` 与 `meta` 两个顶层字段；`requestId` 不再作为 v1 顶层字段返回。v1 `data` 内的公开字段统一使用 snake_case，例如 catalog 使用 `offers[].amount_minor`、`offers[].credit_micros`、`offers[].billing_interval`，checkout 请求使用 `offer_revision_id`、`amount_minor` 与 `quote_snapshot`。

`quote_snapshot` 至少包含 `key` 与 `credit_micros`，可包含 `name` 及其他报价快照字段。传输层将 snake_case 快照适配到既有 CheckoutService 所需的 `key`、`creditMicros`、`name` 等内部字段后再调用服务。

非 `/v1` 旧路径继续保留原有顶层 `requestId` 与 camelCase payload，不与 v1 wire 契约混用。

Error envelope:

```json
{"error": {"code": "billing.invalid_request", "message": "...", "request_id": "req_TARGET", "retryable": false, "details": {}}, "meta": {"request_id": "req_TARGET"}}
```
