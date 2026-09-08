# kokoro-billing 数据模型

B5 执行细节以 TECHNICAL_DESIGN 的全量 catalog drift 放置门为准：目标只读快照、显式 SCHEMA_ADMIN_URL、同实例 template0 自有参照库、全对象差异与有界清理；不改本文件后续 SQL 事实。

## 2026-09-08 数据规范化状态

唯一可编辑Schema继续是`database/schema.sql`。目标采用SQL-first + 只读生成Prisma schema/Client，见
[ADR-0003](ADR/0003-nestjs-prisma-sql-first-alignment.md)。B6a已引入只读生成schema/Client及隔离验证，未改表或业务数据；下面35表是当前态。

必须保留CHECK、业务UNIQUE、receipt identity partial predicates、UTC毫秒精度与BIGINT，不为ORM生成删约束。
Prisma生成模型不表达全部数据库语义，须以完整catalog drift验证；B5全量catalog gate已验收，Prisma生成不能替代它。B6a保留原生introspection自动生成的partialIndexes Preview元数据，
仅限ADR-0003窄例外，不运行db push/migrate；真实partial UNIQUE事务承接继续归B6b。

### 分阶段数据门

- **B4局部安装保护**：现有SQL不变，独占Billing空database，仅public目标；schema query参数缺省/public可用，其余配置在连接前拒绝。
  不存在的public或含任何非系统relation/type/function的database停止安装，不借search_path回落。advisory lock内检查后在同一事务
  执行DDL，固定UTC及超时；失败回滚并释放资源。只读检查既有用户对象，不修改/清理它们。设计细节见TECHNICAL_DESIGN。
- **B5完整drift**：覆盖35表的列/type/precision/null/default、PK/UNIQUE/CHECK/index definition/predicate以及无FK；正反例必须
  证明缺约束/错predicate被识别。比对expected来自canonical SQL安装的隔离参照库，不手写第二份完整Schema。
- **B6 Prisma承接**（详见TECHNICAL_DESIGN B6门；generated schema保留SQL命名identity映射，SQL不变）：生成链、全部模型、typed CRUD、同一tx锁/receipt/outbox、错误映射与BigInt受测后才进入生产替换。
- **B8数据规范切换**：当前`payment_*`/`entitlement_*`、业务名VARCHAR主键、`currency`与Root默认命名有差异；逐表列出
  owner前缀、`id UUID`、`currency_code`映射及索引/约束/writer影响。tenant/subject属于既有opaque契约，不机械改UUID。
  先完成映射与契约验证，随后整个闭合事务组一次替换SQL、Prisma生成、查询、seed、测试；当前名字不冒充目标名字。

Credit/Ledger当前被多个pg类写入；目标由Credit公开事务内能力统一写account/grant/hold/allocation/journal/fulfillment，
Payment/Refund/Metering/Subscription仅编排调用。具体模块表见TECHNICAL_DESIGN；无外键orphan覆盖、retention、append-only
权限和reconciliation运行入口仍是未交付项，不用文档代替安全保障。B4局部门已明确且无Schema/API变更；完整业务/Prisma门仍待验。

Canonical source：[`../database/schema.sql`](../database/schema.sql)。本文说明 owner、关系和不变量；列类型、nullable、
default、CHECK 与索引的最终事实仍以 Schema 为准。

## 1. 存储边界

- Billing 使用 PostgreSQL 16 持久化全部账务事实；Redis 不保存余额、账本、payment status 或 durable receipt。
- Schema 共有 35 张表：10 张 `payment_*`、25 张 `entitlement_*`。
- 所有 tenant-owned 查询/写入必须显式携带 `tenant_id`。跨仓 ID 是 opaque reference，不是外键。
- 数据库时间为 `TIMESTAMPTZ(3)`；money/credit 为 integer minor unit/micros + currency。
- V1 不使用 `FOREIGN KEY` / `REFERENCES`，也没有 migration 链。

## 2. 表 owner inventory

### Credit、usage 与 admission

| 表 | Owner 事实 / 生命周期 |
|---|---|
| `entitlement_credit_account` | tenant + subject 的 credit projection、held、generation 与状态 |
| `entitlement_credit_grant` | 来源唯一的 credit lot、有效期、burn priority、remaining 与状态 |
| `entitlement_credit_hold` | idempotent reservation、requested/captured/released、expiry 与状态 |
| `entitlement_credit_hold_allocation` | 一个 hold 在 grant lot 之间的分配与终态金额 |
| `entitlement_credit_journal` | account append-only delta 与稳定 sequence |
| `entitlement_usage_event` | tenant-scoped usage inbox identity 与处理状态 |
| `entitlement_usage_settlement` | hold 与 usage event 的一对一结算结果 |
| `entitlement_billing_admission` | invocation 的定价、mode、hold、accepted receipt 引用与状态 |
| `entitlement_execution_event` | Agent/Model/Studio execution inbox、payload hash 与状态 |
| `entitlement_command_receipt` | 通用 entitlement command replay fact；expiry 使用 batch command identity |
| `entitlement_billing_command_receipt` | admission/capture/release/execution-event ingress 的 surface-aware replay fact |
| `entitlement_outbox` | entitlement side-effect delivery、lease、attempt、publish/dead-letter 状态 |
| `entitlement_usage_price_revision` | tenant pricing policy revision 与生效窗口 |
| `entitlement_usage_price_rate` | revision 下按 feature/label 的 rate 与 reservation |

### Catalog、fulfillment、subscription 与 redeem

| 表 | Owner 事实 / 生命周期 |
|---|---|
| `entitlement_offer` | tenant 内稳定 offer identity 与启停状态 |
| `entitlement_offer_revision` | 不可混淆的报价 revision、money/credit snapshot 与发布/删除状态 |
| `entitlement_acquisition` | payment/subscription/admin/redeem 等来源形成的 entitlement acquisition |
| `entitlement_fulfillment` | acquisition 是否已 committed/reversed/reconciliation-required |
| `entitlement_fulfillment_reversal` | payment reversal 到 fulfillment reversal 的一对一事实 |
| `entitlement_subscription_term` | provider period 投影出的 tenant/subject entitlement term |
| `entitlement_redeem_campaign` | redeem program、额度、时间窗与使用上限 |
| `entitlement_redeem_code_batch` | operator 发行批次与审计原因 |
| `entitlement_redeem_code` | tenant-scoped code hash、状态与兑换者 |
| `entitlement_redeem` | code、recipient、grant 与 idempotency 的兑换事实 |
| `entitlement_audit_event` | operator action 的 append-oriented 审计记录 |

### Payment、checkout 与 subscription

| 表 | Owner 事实 / 生命周期 |
|---|---|
| `payment_checkout` | subject checkout、quote hash/snapshot、provider session 与状态 |
| `payment_provider_account` | provider external account 到单一 tenant 的映射 |
| `payment_customer_binding` | subject 与 provider customer 的绑定 |
| `payment_provider_event` | 已验证 provider inbox、payload hash、attempt/error 与处理状态 |
| `payment_settlement` | provider payment settlement、金额、currency 与结果 |
| `payment_reversal` | provider reversal/refund、金额、原因与结果 |
| `payment_provider_subscription` | provider subscription identity 与状态 |
| `payment_subscription_period` | subscription period window 与状态 |
| `payment_command_receipt` | payment command replay fact；settlement 与 refund 使用各自业务 command identity |
| `payment_outbox` | payment side-effect delivery、lease、attempt、publish/dead-letter 状态 |

## 3. 关系维护

Schema 不用 FK，因此建立关系必须按以下顺序：

```text
tenant-scoped existence
  -> caller permission / owner check
  -> current state check
  -> deterministic row lock
  -> relation + fact + journal/outbox in one transaction
  -> local UNIQUE/CHECK
  -> reconciliation
```

典型关系：

- account -> grant -> hold allocation -> hold/usage settlement/journal；
- offer -> offer revision -> checkout -> settlement -> acquisition -> fulfillment -> grant；
- provider account -> provider event/checkout/subscription；provider account external identity用于 webhook tenant resolution；
- provider subscription -> period -> entitlement subscription term；
- reversal -> fulfillment reversal -> credit reversal/exposure；
- admission -> hold -> execution event/capture/release receipt。

所有同 owner JOIN 同时连接 tenant lineage；跨仓关系只保留 opaque ref 并由 owner API/context 校验。

## 4. 账务不变量

- `credit_account.available_micros` 与 `held_micros` 非负；写路径用条件 UPDATE 和 generation 防止 projection 下穿。
- Grant：`0 <= remaining_micros <= original_micros`；expiry 晚于 effective time。
- Hold/allocation：captured + released 不超过 requested/held；一个 active hold 最终 capture、release 或 expire。
- Usage settlement：一个 hold 和一个 usage event 各最多对应一个 settlement。
- Journal：delta 非零，account 内 sequence 唯一，同 tenant/source/kind 只写一个事实。
- Money：checkout/settlement/reversal amount 为正，currency 匹配三位大写格式。
- Offer/pricing published 状态要求 publish time；revision/window 唯一且时间窗合法。
- Receipt：同 tenant/command/idempotency key 唯一，并保留 payload hash、status 与 result；需要独立业务命令身份的 surface 还写
  `command_identity`，非空 identity 在 tenant/command 内唯一。
- Settlement receipt identity 为 `settlement_id`；expiry receipt identity 为 `batch_id`。两者的 SHA-256 digest 都包含 command
  version 和规范化字段，result JSON 是 durable replay authority。
- Admission receipt 在 key/command 外增加 `api_surface`；authorize/capture/release/execution-event identity 依次为 invocation、admission、
  admission 与 event ID。Capture/release 的完整 runtime payload 和 execution-event 的 `Idempotency-Key` 均进入 receipt。
- Refund receipt identity 是 provider + external reversal reference 的 canonical digest；checkout 以 tenant/key 唯一的
  `payment_checkout.quote_hash` 保存 versioned command digest。Checkout digest 在当前 offer/catalog 校验之前用于 existing replay。
- 这些 command 的 object payload 递归 canonicalize：object key 顺序不参与 digest，array 顺序参与，非 JSON 值在持久化前拒绝。
- 当前 receipt claim/effect/result 同事务提交，不存在可见 lease/fence reclaim；正常失败回滚 claim。历史 `processing|unknown|failed`
  仅是稳定诊断 outcome，不能据此重新执行 side effect。Succeed receipt 的 `result_json` 缺失或 shape 损坏属于数据库不变量事故。
- `command_identity` 保持 nullable，只因同一通用 receipt 表还服务没有独立业务 identity 的其他 command；partial unique index
  只约束非空值，不削弱 key unique。
- Provider event：同 tenant/provider/external event 唯一；payload hash 冲突不能当作重放。
- Admission：同 tenant/invocation 和同 tenant/idempotency key 唯一；unknown 不隐式 capture/release。

Application 将 journal、audit、inbox/outbox 视为 append-oriented facts；Schema 当前没有 trigger/privilege 在数据库层阻止直接
UPDATE/DELETE，因此生产数据库角色和审计策略仍需补齐该防线。

## 5. UNIQUE 业务语义

| 约束组 | 业务语义 |
|---|---|
| `uq_entitlement_credit_account_subject` | tenant 内一个 subject 只有一个 account |
| `uq_entitlement_credit_grant_source`、`uq_entitlement_acquisition_source` | 同一来源/program 不重复发放或 acquisition |
| `uq_entitlement_credit_hold_idempotency` | tenant 内 reservation key 唯一 |
| hold allocation composite PK | 一个 hold 对一个 grant 只有一条 allocation |
| `uq_entitlement_credit_journal_sequence`、`uq_entitlement_credit_journal_source` | account sequence 与来源事实各自唯一 |
| `uq_entitlement_usage_event_source` | tenant 内 source event 只接收一次 |
| `uq_entitlement_usage_settlement_hold`、`uq_entitlement_usage_settlement_event` | hold 与 usage event 均只能结算一次 |
| entitlement/payment/Billing receipt key UNIQUE | 每个相应 command surface 的 tenant + command + idempotency key 只保留一个 receipt |
| `uq_entitlement_command_receipt_identity` | 非空 entitlement command identity 在 tenant + command 内唯一；当前约束 expiry batch |
| `uq_entitlement_billing_receipt_identity` | 非空 admission/execution command identity 在 tenant + surface + command 内唯一 |
| `uq_payment_command_receipt_identity` | 非空 payment command identity 在 tenant + command 内唯一；当前约束 settlement 与 refund |
| `uq_payment_provider_event_external` | tenant/provider external event 去重 |
| `uq_payment_settlement_external`、`uq_payment_reversal_external` | provider payment/reversal identity 去重 |
| `uq_entitlement_fulfillment_acquisition` | acquisition 只履约一次 |
| `uq_payment_outbox_source_event` | aggregate 的同类 payment event 只入 outbox 一次 |
| `uq_entitlement_fulfillment_reversal_payment` | payment reversal 只产生一个 fulfillment reversal |
| `uq_payment_checkout_idempotency` | tenant 内 checkout key 只对应一个 quote/result |
| `uq_entitlement_offer_site_key` | tenant 内 offer key 唯一（约束名保留 `site` 历史词，字段语义已是 tenant） |
| `uq_entitlement_offer_revision_number` | offer revision number 唯一 |
| `uq_entitlement_usage_price_revision_site_number` | tenant pricing revision number 唯一（约束名保留 `site` 历史词） |
| `uq_entitlement_usage_price_rate_identity` | revision + feature + nullable label 的 rate identity |
| `uq_payment_provider_account_external` | provider external account 全局只映射一个 tenant |
| `uq_payment_customer_binding_external` | provider account 内 external customer 唯一 |
| `uq_payment_provider_subscription_external` | tenant/provider subscription identity 唯一 |
| `uq_payment_subscription_period_window` | provider subscription 的同一 period window 唯一 |
| `uq_entitlement_subscription_term_period` | provider period 只投影一个 entitlement term |
| `uq_redeem_campaign_key`、`uq_redeem_code_hash` | tenant 内 campaign key 与 code hash 唯一 |
| `uq_redeem_code_once`、`uq_redeem_idempotency` | code 只兑换一次；recipient command 可安全重放 |
| `uq_entitlement_admission_invocation`、`uq_entitlement_admission_idempotency` | invocation 与 admission command identity 唯一 |
| execution event composite PK | tenant 内 event ID 唯一 |

注意：PostgreSQL 的普通 UNIQUE 允许多个 NULL；`usage_price_rate_identity` 的 nullable `label_key` 不能单独证明
“每个 feature 只有一个 NULL label”。当前 repository 查询按 revision 降序/ID 收敛，但若该业务唯一性必需，后续需显式
NULLS NOT DISTINCT 或等价约束设计。

## 6. 查询索引

Canonical Schema 当前定义 14 个显式 index：11 个查询/dispatch access path，加 3 个 receipt command identity unique index。

- grant expiry、hold expiry；
- entitlement/admission/payment receipt command identity；
- entitlement/payment outbox dispatch；
- provider event processing；
- settlement by checkout、reversal by settlement、checkout by status；
- subscription term by subject；
- admission by status、execution event processing。

PK/UNIQUE 自带索引，不重复声明。索引用途变化必须同时更新查询、Schema、integration test 与本文。

## 7. JSON 与敏感数据

`quote_snapshot_json`、provider/event payload、receipt、outbox、dimensions、metadata 与 audit payload 使用 JSONB。它们是边界快照或
扩展 metadata，不替代 tenant、状态、金额、关系或查询字段。Provider/receipt payload 可能包含敏感数据；日志不得输出完整值，
访问与 retention 应按最小权限管理。

## 8. Retention、备份与删除现状

- Schema 未实现 partition、TTL、archive table 或 GC job。
- Outbox 有 published/dead-letter 状态但无自动清理；provider/execution inbox、receipt、audit 和 journal 也无仓内 retention job。
- Offer revision 有显式 soft-delete 字段；其余表的删除语义由各自状态表达，未提供通用 soft delete。
- 仓内没有备份策略、RPO/RTO 或 restore drill 证据。

上线前必须由 Billing owner 与合规/运维明确每类事实的保留期、legal hold、脱敏/删除语义、备份加密与恢复验证；在此之前不得
执行临时 DELETE 清理账务事实。


## B6b 隔离数据承接证据

当前canonical SQL与生成schema未变。新增真实Prisma测试覆盖账户typedCRUD/BigInt精度与UTC毫秒、receipt的DbNull/JsonNull，
receipt/account/journal/outbox单事务提交/回滚/外连接不可见；key UNIQUE与partial identity UNIQUE独立反例，跨tenant正例。
行锁与SKIP LOCKED带tenant条件，真实pg_stat_activity锁等待后释放；具体预算错误语义见TECHNICAL_DESIGN末尾。
这证明当前映射可承接所测能力，不代表35表所有用例已重写；生产pg writer、共享receipt/audit/outbox公开面及B8命名切换仍待实施。
