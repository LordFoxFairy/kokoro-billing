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

Error envelope:

```json
{"error": {"code": "billing.invalid_request", "message": "...", "request_id": "req_TARGET", "retryable": false, "details": {}}}
```
