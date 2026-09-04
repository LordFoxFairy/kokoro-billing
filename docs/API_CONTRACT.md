# kokoro-billing API 契约策略

Canonical machine-readable source：[`../contract/openapi/v1/openapi.yaml`](../contract/openapi/v1/openapi.yaml)。本文件解释
owner、身份、幂等、错误与 consumer 规则，不复制字段级 Schema。Contract 的 version/generation/breaking/provenance 见
[`../contract/README.md`](../contract/README.md)。

## Visibility 与版本

- Owner：`kokoro-billing`。
- Visibility：全部 operation 为 `internal-owner`。Provider webhook 虽接收外部 provider 流量，仍是 Billing 的受控 ingress，
  不是 Kokoro Developer Product API。
- Stability：当前 operation 标为 `stable`，wire document `info.version=1.0.0`。
- 非探针路径必须位于 `/v1/**`；`/healthz`、`/readyz`、`/metrics` 是内部运行端点。
- Root Developer API 门户只发布 BFF 的 `public` contract，不发布本契约。

## Operation 与身份

| Operation | 当前 caller / permission | Idempotency metadata |
|---|---|---|
| `GET /healthz`、`GET /readyz`、`GET /metrics` | network policy 下的 probe/scraper；应用层无 auth | `inherent` |
| `GET /v1/commerce/catalog` | IAM user，或完整 `web-bff` service-auth | `read-only` |
| `GET /v1/billing/me/credit-account` | IAM user JWT + matching tenant | `read-only` |
| `GET /v1/billing/me/credit-ledger` | IAM user JWT + matching tenant | `read-only` |
| `GET /v1/billing/me/subscriptions` | IAM user JWT + matching tenant | `read-only` |
| `POST /v1/billing/checkout` | IAM user，或含 subject 的完整 `web-bff` service-auth | required header + checkout fact/hash |
| `POST /v1/internal/entitlement/admissions` | `agent`、`model`、`studio` | required + durable Billing receipt |
| `POST .../admissions/{admissionId}/capture` | `agent`、`model`、`studio` | required + durable Billing receipt |
| `POST .../admissions/{admissionId}/release` | `agent`、`model`、`studio` | required + durable Billing receipt |
| `POST /v1/internal/billing/execution-events` | `agent`、`model`、`studio` | required header；event ID + payload hash 是 durable identity |
| `POST /v1/internal/payment/settlements/accept` | 当前实现允许 `payment-worker` 或 `scheduler` | required；`settlement_id` identity + PostgreSQL receipt/digest |
| `POST /v1/internal/payment/refunds/accept` | `payment-worker` | required + reversal fact/receipt |
| `POST /v1/internal/commands/expire-credit-holds` | `scheduler` | required；`batch_id` identity + PostgreSQL receipt/digest |
| `POST /v1/webhooks/payment/{provider}` | provider-specific signature + account-to-tenant mapping | provider + external event ID |
| `POST /v1/admin/billing/refunds` | trusted admin proxy + role `billing.admin` | required + reversal fact/receipt |

`X-Kokoro-Tenant-Id` 是受信 tenant context，不从 JSON、query、provider payload、account ID 或 runtime namespace 推导。

## Storefront 的两条互斥身份路径

用户路径使用 IAM RS256 JWT；JWT 的 `tenant_id` 必须与 `X-Kokoro-Tenant-Id` 相同，subject 来自 `sub`。BFF 路径同时要求：

```text
X-Kokoro-Service: web-bff
X-Kokoro-Internal-Secret: TOKEN
Authorization: Bearer TOKEN
X-Kokoro-Tenant-Id: TENANT
X-Kokoro-Subject: SUBJECT    # checkout 必需；catalog 可省略
```

一旦请求包含内部 marker，Billing 就锁定 service-auth 分支；失败不会降级为用户 JWT。BFF alternative 不适用于
`/v1/billing/me/*`。

## Internal、admin 与 webhook

- Internal service 必须携带 registered `X-Kokoro-Service`、`X-Kokoro-Internal-Secret` 与 tenant context；每条 route 再做
  allow-list。
- Admin 必须由 `X-Kokoro-Service: admin`、独立 proxy secret、operator identity 和精确 role `billing.admin` 组成。
- Provider webhook 在持久化前做 provider-specific raw-body signature 验证。生产 provider 集合与签名位置固定为：

  | Provider | Content type / signature source |
  |---|---|
  | `stripe` | raw JSON + `Stripe-Signature` header |
  | `alipay` | `application/x-www-form-urlencoded` body 中的 `sign` 与 `sign_type=RSA2`；不读 query/header alias |
  | `wechat` | raw JSON + `Wechatpay-Timestamp`、`Wechatpay-Nonce`、`Wechatpay-Signature` headers |

  OpenAPI 标准 security scheme 不能表达 body field authentication，因此 Alipay 的位置由必填 `AlipayWebhookForm` 与
  `x-kokoro-provider-signatures` 共同约束；contract 不声明伪造的 query scheme。生产 `jwks` 模式从 provider account mapping
  解析 tenant；payload tenant 若存在必须一致。
- Execution event 不携带第二套 caller-selected signature 字段；信任来自已认证 service context。

## Envelope、命名与数值

v1 成功和失败分别为：

```json
{"data": {}, "meta": {"request_id": "req_TARGET"}}
```

```json
{"error": {"code": "billing.invalid_request", "message": "...", "retryable": false, "details": {}}, "meta": {"request_id": "req_TARGET"}}
```

外部 JSON 使用 snake_case。金额与 credit 通过 decimal string 传输，进入 application 前检查 JavaScript safe integer 范围；
数据库使用整数。当前例外是 ledger `created_at` 使用 epoch milliseconds，见“缺口”。

## 幂等、并发与重试

- 声明 `required` 的 operation 要求 8–128 个 printable ASCII 字符的 `Idempotency-Key`。
- 同一 tenant/command/key + 同一规范化 payload 返回原事实；同 key 不同 identity/payload 返回
  `billing.idempotency_conflict`（409）。
- Settlement command name 是 `payment.settlement.accept`，identity 是 `settlement_id`。Digest 覆盖版本化 command、provider、
  external payment reference、amount、currency 及可选 provider event/checkout identity；成功结果持久化后按 key 或 identity 重放。
- Expiry command name 是 `entitlement.credit-holds.expire`，identity 是 `batch_id`。Digest 覆盖版本化 command、batch 与规范化后的
  `limit`（缺省值 100）；成功结果保存精确 `expired_hold_ids`，重放不再次扫描。
- 对这两个 command，同 identity 换 key 仍读取同一 receipt；同 key 换 batch/settlement 必须 409，不能消费下一批事实。
- Settlement/expiry 不通过 Redis raw-body fingerprint 做冲突短路，因为字段顺序或显式/隐式默认值不是业务 payload drift；
  PostgreSQL receipt 是唯一裁决。其他已接入 hint 的入口也必须以自己的 PostgreSQL fact/receipt 为最终权威。
- Provider webhook 不要求 caller 生成 Idempotency-Key，以签名后的稳定 external event ID 去重。
- 只有已知 retryable 结果可使用原 key 重试；不确定结果先查询/reconcile，不创建新 key。

## 分页

Catalog、credit ledger、subscription 使用 `limit`（1–100）与 opaque `cursor`。Cursor 绑定 resource scope 和 tenant；ledger
还绑定 subject 及稳定排序键。损坏、跨 tenant/subject 或非法 cursor 返回 `billing.invalid_cursor`。Consumer 不解析 cursor，
只回传 `next_cursor`。

## 错误策略

稳定错误 namespace 为 `billing.*`。当前重要类别：

| 类别 | 示例 | HTTP/重试语义 |
|---|---|---|
| 身份/权限 | `billing.unauthorized`、`billing.forbidden`、`billing.service_auth_failed` | 401/403；修正身份，不自动重试 |
| 输入/协议 | `billing.invalid_request`、`billing.idempotency_required`、`billing.invalid_cursor` | 400；修正请求 |
| 额度 | `billing.insufficient_credit` | 402；业务终态 |
| 冲突/未知 | `billing.idempotency_conflict`、`billing.command_in_progress`、`billing.command_unknown` | 409；按原 key 查询/重放/对账 |
| 依赖/配置 | `billing.dependencies_not_ready`、`billing.*_not_configured` | 503；受控退避 |
| 内部错误 | `billing.internal_error` | 500；不泄漏 provider/SQL/stack |

Transport 会补齐 `retryable`、`details` 与 `meta.request_id`；consumer 只依赖稳定 code，不解析 message。

## Contract-first 变更

```text
Billing OpenAPI source
  -> contract governance/route/shape checks
  -> implementation + transport/contract tests
  -> versioned artifact (commit/tag + digest)
  -> pinned consumer update
  -> integration/smoke
```

不手改 generated artifact，不从 Root 或 consumer 复制第二份 editable DTO。

## 当前 contract 缺口

- Settlement/expiry request body、result 和 409 已闭环；其他 mutation 仍有不完整 request body、精确 response 或错误集合，部分
  response 使用 generic schema。
- 当前 checker 不执行 historical OpenAPI breaking diff，也没有机器 provenance manifest/artifact publish job。
- Ledger `created_at` 是 epoch milliseconds，不符合平台 RFC 3339 UTC 目标。
- Route parity 不能证明运行时 Zod 与 OpenAPI 字段语义完全一致；在补齐 shape 前需人工逐 route review。
