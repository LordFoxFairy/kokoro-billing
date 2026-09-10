# kokoro-billing API 契约策略

B5/B6 仅新增离线 catalog/Prisma 生成和隔离承接验收命令，不变更 17 个 HTTP operation、wire schema、身份、状态或消费者；OpenAPI 保持不变。

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

## B8-R2 模型收敛与幂等约定（目标，机器契约未变）

- Prisma事务、SQL-first结构管理和Redis辅助去重是内部工程选择，不新增HTTP事务参数、Redis锁token或ORM类型。
  客户端仍使用明确的幂等身份；同identity同digest读原持久结果，改变参数为冲突，不能因Redis TTL过期获得再次发放资格。
- 目标把acquisition/fulfillment合成永久CreditFulfillment，业务结果保留fulfillmentId/grantId/journalId语义；
  当前机器契约未定义独立acquisition资源，本轮不新增其endpoint或对外暴露acquisition_id。
  这不证明仓外没有历史事件/数据引用；真实ID迁移和breaking仍经D2门，不原位改变stable v1。
- 当前一次性付款/单item订阅profile每个来源只发一次、一份grant、一个program。program是不可变授权的一部分，
  同source换program等授权参数为冲突；换幂等key但identity/digest相同仍重放原结果，不再次发放。
  未来多program/multi-item需独立profile与契约设计，不能静默扩大journal来源语义。
- 退款保留独立credit_fulfillment_id/credit_grant_id与每笔冲正结果；零delta已应用可没有journal。
  订阅资格/等待/term与Credit已发放结果分别展示，T1 accepted不等于T2 applied。

本节不修改现有17条operation或生成artifact；核验命令只证明当前契约仍有效，不证明新模型或major已实施。

## B8-D1事务目标与B8-D2契约边界（2026-09-10）

B8-D1提供内部模块/事务设计，数据映射由B8-R2继续修订；SQL/OpenAPI仍是当前v1字节；它不批准任何HTTP breaking实施。
所有带幂等的业务变更继续遵守trusted tenant/actor、key+identity+versioned digest、成功durable result同提交；
内部Prisma UUID/BigInt/JSON/错误不得泄漏为未经定义的wire形状，本文下方v1既有字段与行为仍有效。

| 身份类别 | 目标数据库语义 | 当前契约影响 |
|---|---|---|
| Billing自己产生的checkout/account/grant/hold/admission/usage/receipt等资源 | 应用UUID主键与本地引用 | 部分v1 schema未声明UUID；客户端accepted input先逐项审核，不原位收窄 |
| caller settlement_id | 当前既是PK也是command identity/result/refund定位 | 必须决定生成权、外部业务identity命名、digest版本与major切换；未决定前不改字段 |
| provider_event_id（内部）与event_id（外部） | 前者UUID、后者opaque；execution同理新增内部UUID | 不能让外部provider/Agent为了内部PK格式更改其事件ID |
| tenant/subject/operator/invocation/execution/provider reference/batch_id | 外部opaque或命令identity | 保留定义与长度，不加通用UUID管道；batch/command identity不是资源PK |
| cursor | opaque、绑定tenant/resource及稳定排序 | 不复用数据库ID当无签名跨scope cursor |

B8-D2必须从以下两个完整方案作一次决定，不实现长期双轨：
1. 推荐新major owner contract，一次切换全部真实消费者与配置，移除v1入口/旧header/envelope；Billing拥有内部资源UUID，
   调用者提供独立业务identity，receipt/digest与refund lookup均明确。先证明当前部署/真实数据状态，再决定仅fresh install还是独立数据演进ADR。
2. 保持已发布v1资源identity，仅进行无wire变化的内部模型映射，同时另列真正major发布目标；如果采用此方案必须明确为何仍满足既定最终规范，
   不能把它当隐藏alias/fallback或以“兼容”为由取消目标中的request-id/UTC等收敛。当前未采用此方案。

已询问线上账务数据/仓外调用方状态，尚未收到事实回答；空GitHub release/tag列表不能证明未部署。Root不擅自选择清库、原位改stable v1或造假消费者不存在。
这里的major切换决定必须单独确认；内部目录、writer、事务失败策略由Root按既定规范裁决，无需把普通命名问题交给用户。

### HTTP接受事实与Credit效果：必须闭环的契约项

当前settlement accept、internal refund、admin refund三入口只返回202接受事实；Recorded outbox没有仓内生产消费者，独立webhook的处理不能充当该HTTP链保证。
B8-D2须明确每入口到底承诺fact-only还是durable后续effect，以及消费者能如何知道结果；不能仅改202文案制造实现已完成的印象。
设计优先采用同一owner幂等effect能力：已具备可信checkout/program/subject快照时可在同事务完成，确需异步则注册具名handler、bounded retry/dead-letter与真实终态查询。
缺失关联不能按payment金额猜测Credit，也不增加向provider主动退款的未请求功能。若fact-only确是业务需求，则移除“待处理”的虚假承诺，
对应通知事件需明确真实接收者或随切片删除无人消费的路径；不设置空handler直接ack。

本轮机器契约/Schema验证仍证明当前v1，不证明上述目标已生成或已兼容。完整重写门未通过，不能以B8-D1内部审查替代B8-D2。

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


## B7b 输入边界收窄记录（2026-09-10）

本切片未改变canonical OpenAPI字段/路由/版本。内部持久化quote credit只接受string|number并继续既有整数范围校验；
execution receipt的provider_operation_ref若存在且非null，须为string，否则处理时报billing.execution_receipt_invalid并回滚capture。
null/缺省保持event fallback。webhook先使用provider解析结果，仅对缺省结果的raw ID/type fallback做string校验；
非法对象/数组/布尔/数字fallback返回既有400 billing.provider_payload_invalid，null/缺省保持既有空ID/unknown。
这是显式记录的输入收窄，不宣称错误输入行为完全不变；完整机器契约/消费者切换仍归B9。

## B8-S0当前Stripe回调的paid-only准入修复

只改变既有Stripe Checkout事件的内部归一化：明确payment模式且payment_status=paid、无subscription引用才进入一次性付款效果；
其他事件保持原type交当前processor ignored，不以完成Checkout页面推断资金到账。缺省mode/status的旧合成fixture此前被错误放行，现收窄，不冒称非法输入行为完全不变。
HTTP路径/身份/raw body SDK验签/inbox去重/响应状态与schema不改；迟到的async成功事件仍可处理。当前金额严格正数的profile不自动给no_payment_required发放Credit。
该局部修复沿用当前机器契约，并不批准stable v1的UUID/header/envelope/版本切换；订阅及免费权益政策仍有未决项。


## B8-D2a Checkout内部结果与待决wire边界

本轮不改stable v1机器源。目标内部Checkout结果为具名联合：pending（持久已接受/等待恢复）、ready（已有session identity；URL可能因provider终态为空）、
failed（明确且持久session_had_unknown及本SDK调用uncertainty均为false的未执行错误）、review_required（未知结果超预算或身份冲突）。这是owner内部业务结果，不是另写一份wire DTO/schema。
同tenant/subject/key只能指向一个固定Checkout；重试同请求可查询当前状态，不能生成第二session/provider key；不同digest依旧conflict。
prepare准入截止quote_expires_at与provider_session_expires_at必须在最终机器contract分别说明，不将当前expires_at原位改义。

目标调用者应能够取得已持久接受的Checkout identity并查询后续状态，不能以无ID的通用500或201+缺URL假装可用付款页；
exact status code、Location、查询operation、稳定错误码与重放语义在同一新major owner contract一次裁决，消费者随后更新并移除旧入口。
本设计不预建新HTTP路径/双协议，不把尚不存在的查询或管理员修复接口写成当前能力。提供这些能力是B8/B9待交付项而不是删除目标。
UI取消跳转/付款成功跳转仅是导航，不能作为支付、退款或取消平台会话的权威事实。

Checkout只读导入Payment核心账户公开能力，所有tenant/actor从受信上下文取得；任何account/provider_environment/checkout_session_mode/session绑定字段均不从用户body自报后直接采信；环境test/live和会话payment/subscription是两个独立维度。
Provider verified事件是独立确认通道，但仍需本仓snapshot金额/币种/身份一致和幂等Credit效果；不能把create ready或subscription active等同已收款。

尚待用户事实/major确认的范围仍如B8-D2段：现有账务数据、仓外v1调用者、数据演进方式与整体breaking契约。当前17operation/SQL原样验证不证明未来状态机/Schema通过。

## B8-D2c退款语义与终态边界（内部设计R2已审查，机器v1不变）

D2b所测三个accept入口的成功receipt仅表示记录命令完成，不证明Stripe创建退款、渠道成功或Credit冲正成功。
新major必须分别描述“发起商户退款命令”“接受受信退款观察”“查询退款及Credit效果”，不把同一202同时解释为三种完成。
内部query结果包含refund identity、准确provider观察状态、独立credit_effect_status与review标记；发生渠道失败回流时可同时显示provider failed和credit applied/review，不掩盖已有账务。
命令receipt重放仍返回原record接受结果，当前状态从受信owner query获得；不要通过每次重放改写receipt来假装它是最新状态查询。
RefundRecord/RefundQuery为内部业务input/result，不在contract另存可编辑Application DTO；机器schema与新HTTP status/Location/分页/错误在major切片统一发布和验证。

Stripe退款身份是执行账户scope下Refund.id；Event.id只表示观察投递，不能当退款身份。charge/PI/币种须与已持久付款关联，tenant/actor/账户授权来自受信上下文。
metadata.checkout不是授权与唯一付款选择条件。missing identity/amount、累计charge amount、未知status不得归一化成功；金额只接受该provider定义的integer minor单位，不使用共享decimal major转换器。
当前line_specific缺选择器/算法，不保留“接受后忽略”的目标；其确切行模型、订阅退款与商户发起退款策略仍需业务/major门。
record root与provider observation effect分离：无已验证渠道证据的record返回接受结果，但查询明确provider unknown、credit waiting_provider，不enqueue扣账；provider观察加入ProviderEvents同事务，不claim第二record receipt。
Stripe JSON number金额先Number.isSafeInteger且>0后转BigInt；unsafe/fraction/string/object/null不以隐式转换或累计金额补齐。
单grant比例冲正沿既有规则，结果允许0 micros（如1 credit拆3次退款），零delta在身份/策略检查通过且无review时为已应用结果；此前本链冲正造成exhausted不阻断，expired/revoked仍review。查询可无journal ID，不能宣称账本漏写。
用户跳转/管理员点击/返回accepted均非渠道成功证据；provider succeeded之后也可能failed，查询与告警应展示需复核而不是自动补发或隐藏历史冲正。

实施前必须补齐两个refund的机器request/response/error shape、账户/tenant权限、幂等与状态查询、消费者artifact更新；切换时删除被替代旧v1入口与reason前缀含义，不提供长期双协议。
尚未获得真实数据/仓外消费者事实确认，本节不改变当前17operation或API版本，不把缺失的终态查询写成当前可调用功能。

## B8-D2d订阅契约目标（机制R2已审查，商业发放规则待确认）

当前Subscription parser输出的grantCredits是实现中的猜测，不作为目标provider contract；目标区分生命周期观察、Invoice/line结清证据和Credit资格/应用结果。
Invoice.paid不能被描述成新增银行卡实收；实际Payment资金来源与结清方式分别保留。普通付费周期发放、试用/零额/余额抵扣/手工结清等资格尚待业务确认，当前v1不静默改变这些含义。

Subscription绑定必须来自受信Checkout和执行账户关联；删除以metadata.teamId/planId选择subject/最新offer的目标路径，不增加teamId/subjectId旧新双读。
现代items周期与Invoice服务line身份必须完整，分页/多item歧义显式待复核；period.id、invoice/line ID、subscription.id和event delivery ID不可混用。
当前GET /v1/billing/me/subscriptions返回的subscription_id实为term.id；新major需明确资源身份及生命周期/账单/发放三维状态，owner contract与BFF消费者同切片更新，不原位变义。
金额JSON number先safe-integer校验、时间戳转换后须有效UTC；不同金额字段的零/负数规则按Invoice实际语义，不用Refund正数规则一刀切。

record观察接受不表示Credit已经可用，query显式区分waiting_evidence/waiting_period_start/pending/applied/review与队列失败；未开始的服务期不得提前承诺available。
同period相同授权成功后，过期/取消/下架不破坏历史结果重放；query展示当前状态，不能反过来重写receipt或再发一次额度。
同一invoice服务行与同一订阅item周期有两道唯一性，避免事件重发或另开invoice重新发放；变更计划/补差价/宽限/试用赠送/退款关联需明确业务契约，不用active状态代替。
完整机器request/response/error、分页、状态转换与对外授权只在major门统一落地。本轮机器17operation/版本未改，待批准policy不得当默认配置启用生产发放。

D2d状态澄清：合格但DB now<start时明确waiting_period_start，窗口内pending，首次过期review；到期同事务转pending并应用，失败不虚报余额可用。
分页/网络暂态尚未取得完整观察时inbox继续有界重试，耗尽dead-letter；已完整但未结清的waiting_evidence由后续Invoice事件或现payment worker持久due扫描补查，不依赖一定有下一条webhook。
自动补查耗尽展示review与原因，不伪造invoice failed；政策未批准不轮询或发放。资金证据区分InvoicePayment分配额/账户scope稳定引用与可空Payment settlement，不以PI总额或纯事件名证明结清方式。


## B8-D3 对账运维报告目标（非现行HTTP接口）

保持当前v1 OpenAPI17操作和旧reconcile HTTP404；目标为tenant必填的一次性owner CLI，schema-first机器报告另放本仓contract/reconciliation/report.schema.json（本轮尚未创建），不向BFF/Web发布新的网络入口或假设已有Scheduler client。

目标JSON：schema_version、run_id、tenant_id、as_of、finished_at、status（ok/drift/incomplete/failed）、complete、limits、checks、error_codes。checks逐项含code、owner、category、status、examined、finding_count、pending_count、items、items_truncated、scan_complete；item包含tenant与具名resource refs和适用generation/digest，不包含provider payload/URL/token/自由异常。数值溢出风险字段按十进制字符串、时间UTC，与现有wire约定一致。

required checks全部完成且无异常才ok；扫描未覆盖完即incomplete，即使已有drift也不宣称完整。完整但有差异为drift；权限/Schema/解析等运行错误failed。样本展示截断不等于扫描截断；不接受跨run cursor续接成一致snapshot。退出码0=完整ok、2=完整drift、3=incomplete、1=failed。正常pending只在owner有效恢复证据/期限内计数，不宣称付款或发放已经完成。

报告只观察、不重试、不repair。受控重试仍属于各owner已有/目标的审计命令，须检查tenant/权限/原命令identity/当前generation与状态；本CLI不新增通用force/retry-all入口。Schema/CLI/周期触发/角色与contract测试均仍待实施。
