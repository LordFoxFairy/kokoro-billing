# kokoro-billing API 契约策略

## 2026-09-08 当前契约与目标差异

下文是当前OpenAPI/运行时语义，并不表示已符合最新Root API手册。B3文档及B4安装保护切片不改任何HTTP字段、路径、
身份、状态码、cursor、digest或响应；17个operation的当前contract SHA保持不变。目标与实施顺序见
[ADR-0003](ADR/0003-nestjs-prisma-sql-first-alignment.md) 和 [任务板](IMPLEMENTATION_PLAN.md)。

后续contract切片必须处理：

1. request ID只通过`x-request-id`响应header传输；删除当前`x-kokoro-request-id`与`meta.request_id`，不建header alias。
2. ledger instant改RFC3339 UTC；金额/credit仍以当前十进制wire及显式精度规则表达，不把Prisma bigint直接送JSON。
3. feature typed error与HTTP mapper分离；逐码确定status/retryable/safe message，不按`Error.message`前缀或“全部409可重试”推断。
4. 补全17个operation的request/response/error语义，说明202已提交的接受事实与后续业务终态，以及真实存在的查询/取消能力；
   不为凑契约编造endpoint。design-first YAML维持唯一机器来源，生成validator或全量semantic parity须先验证。
5. 当前契约标stable且ADR-0002要求major breaking。上述wire变更属于breaking，必须先核验实际发布/消费者，再单独记录
   clean-slate owner/consumer切换裁决；此轮不擅自将stable v1原位改写，不预建双协议或长期兼容窗口。

这些目标尚未进入机器契约，完整API切换门未通过。B4只操作离线安装入口，无传输契约变更，可按局部设计实施。

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
| `POST /v1/internal/billing/execution-events` | `agent`、`model`、`studio` | required；event ID identity + PostgreSQL receipt/digest |
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
- Admission command receipt 额外包含 API surface。Authorize、capture、release、execution-event 的唯一业务 identity 分别是
  `invocation_id`、path `admissionId`、path `admissionId`、`event_id`；capture/release 在任何 admission 终态短路前先核对 receipt。
  Capture digest 覆盖 accepted receipt 全部字段；release digest 覆盖 `invocation_id`、`reason` 与可选 `service_receipt`；execution
  digest 覆盖完整 event envelope。它们都保存 HTTP `Idempotency-Key` 和持久化 result。
- Checkout 直接以 `payment_checkout` 作为 tenant/key durable fact。带版本的 digest 覆盖 subject、offer revision、金额、currency 与
  完整 quote snapshot；object key 在所有深度排序、array 顺序保留、非 JSON 值拒绝。Existing key 的 digest/replay 在读取当前 catalog
  之前裁决，因此首次成功后的 offer disabled 不使原命令失去可重放性。
- Settlement command name 是 `payment.settlement.accept`，identity 是 `settlement_id`。Digest 覆盖版本化 command、provider、
  external payment reference、amount、currency 及可选 provider event/checkout identity；成功结果持久化后按 key 或 identity 重放。
- Expiry command name 是 `entitlement.credit-holds.expire`，identity 是 `batch_id`。Digest 覆盖版本化 command、batch 与规范化后的
  `limit`（缺省值 100）；成功结果保存精确 `expired_hold_ids`，重放不再次扫描。
- Refund command name 是 `PaymentReversal`，业务 identity 是 provider + external reversal reference；versioned digest 覆盖 settlement、
  provider/external ref、amount、reason 与可信 admin operator。Receipt claim 使用 `ON CONFLICT` 后锁定并比较，独立连接的等价并发
  重放同一 reversal，payload drift 返回 409。
- 对具备业务 identity 的 command，同 identity 换 key 仍读取同一 receipt；同 key 换 identity/payload 必须 409。
- Redis hint 只写 tenant/route/key 的短 TTL presence marker，不接收或比较请求 body/digest，也不返回 replay/conflict 裁决。
  Redis miss、timeout、坏记录和 JSON 字段顺序不改变结果；API/expiry 在 Redis 丢失时继续 PostgreSQL path，`/readyz` 报告
  `redis=degraded`。规范化 command 与 PostgreSQL receipt/owner fact 是唯一裁决。
- Receipt claim/effect/result 在单一 PostgreSQL transaction 内完成，当前不承诺 processing lease/reclaim。可见历史
  `processing|unknown` 返回 `billing.command_unknown`，`failed` 返回 `billing.command_failed`。
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
| 冲突/未知 | `billing.idempotency_conflict`、`billing.command_failed`、`billing.command_unknown` | 409；按原 key 查询/重放/对账 |
| 依赖/配置 | `billing.dependencies_not_ready`、`billing.*_not_configured` | 503；受控退避 |
| 内部错误 | `billing.internal_error` | 500；包括 durable result 不变量损坏；不泄漏内部 code/provider/SQL/stack |

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

- Capture/release request body、execution-event 409、settlement/expiry request body 与 Redis readiness 状态已纳入 checker；其他
  mutation 仍有不完整 request body、精确 response 或错误集合，部分 response 使用 generic schema。
- 当前 checker 不执行 historical OpenAPI breaking diff，也没有机器 provenance manifest/artifact publish job。
- Ledger `created_at` 是 epoch milliseconds，不符合平台 RFC 3339 UTC 目标。
- Route parity 不能证明运行时 Zod 与 OpenAPI 字段语义完全一致；在补齐 shape 前需人工逐 route review。
