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

## B8-D1 目标映射与一致性不变量（内部设计已审查，未应用DDL）

本节与TECHNICAL_DESIGN的B8-D1共同描述目标；后文原表名仍为当前SQL事实。下列35表一对一映射，不合并receipt/outbox，不创建第二可编辑Schema。
每表资源主键改`id UUID`、应用生成；同仓资源引用改对应`*_id UUID`，跨仓opaque身份保持原语义。所有`currency`列目标为`currency_code`。
表/约束/索引采用billing owner命名且UTF-8名称不超过PostgreSQL63字节；新的精确SQL生成后必须全catalog复验，不手工维护第二份字段快照。

| 当前canonical表 | 目标表 | 唯一写入组件的归属 |
|---|---|---|
| `entitlement_credit_account` | `billing_credit_account` | credit |
| `entitlement_credit_grant` | `billing_credit_grant` | credit |
| `entitlement_credit_hold` | `billing_credit_hold` | credit |
| `entitlement_credit_hold_allocation` | `billing_credit_hold_allocation` | credit |
| `entitlement_credit_journal` | `billing_credit_journal` | credit |
| `entitlement_usage_event` | `billing_usage_event` | metering |
| `entitlement_usage_settlement` | `billing_usage_settlement` | metering |
| `entitlement_command_receipt` | `billing_command_receipt` | database/CommandReceiptRepository general |
| `entitlement_outbox` | `billing_outbox` | database/OutboxRepository credit |
| `payment_provider_event` | `billing_provider_event` | payment |
| `payment_settlement` | `billing_payment_settlement` | payment |
| `payment_reversal` | `billing_payment_reversal` | refund |
| `entitlement_acquisition` | `billing_credit_acquisition` | credit |
| `entitlement_fulfillment` | `billing_credit_fulfillment` | credit |
| `payment_outbox` | `billing_payment_outbox` | database/OutboxRepository payment |
| `entitlement_fulfillment_reversal` | `billing_credit_fulfillment_reversal` | credit |
| `payment_checkout` | `billing_checkout` | checkout |
| `entitlement_audit_event` | `billing_audit_event` | database/AuditAppender |
| `entitlement_offer` | `billing_offer` | checkout |
| `entitlement_offer_revision` | `billing_offer_revision` | checkout |
| `entitlement_usage_price_revision` | `billing_usage_price_revision` | metering |
| `entitlement_usage_price_rate` | `billing_usage_price_rate` | metering |
| `payment_provider_account` | `billing_provider_account` | payment |
| `payment_customer_binding` | `billing_customer_binding` | payment |
| `payment_provider_subscription` | `billing_provider_subscription` | subscription |
| `payment_subscription_period` | `billing_subscription_period` | subscription |
| `entitlement_subscription_term` | `billing_subscription_term` | subscription |
| `payment_command_receipt` | `billing_payment_command_receipt` | database/CommandReceiptRepository payment |
| `entitlement_redeem_campaign` | `billing_redeem_campaign` | credit |
| `entitlement_redeem_code_batch` | `billing_redeem_code_batch` | credit |
| `entitlement_redeem_code` | `billing_redeem_code` | credit |
| `entitlement_redeem` | `billing_redeem` | credit |
| `entitlement_billing_command_receipt` | `billing_admission_command_receipt` | database/CommandReceiptRepository admission |
| `entitlement_billing_admission` | `billing_admission` | metering |
| `entitlement_execution_event` | `billing_execution_event` | metering |

Credit表只被Credit具名Repository更新；Payment/Refund/Metering/Subscription取得公开业务结果而非数据库model。Audit/receipt/outbox三种支持能力仅负责存储不变量，
不取得独立业务owner。payment outbox原有aggregate_type+aggregate_id+event_type唯一性原样保留；credit outbox不因此被暗加同一唯一性。

### ID、字段与无外键关系

- Allocation由复合主键改应用UUID `id`，原hold/grant组合仍为UNIQUE；Execution新增内部UUID `id`，原tenant+外部event_id保留UNIQUE。
- 同仓外键式引用不创建FK/REFERENCES；每次写入在同一事务内校验tenant、存在性、state与owner引用，reconciliation检测漏项。
- tenant_id、subject_id、actor、invocation/execution/source/provider外部identity、command identity与cursor不能仅因名字含id就改UUID。
  polymorphic source_ref保持opaque并由source_kind解释；不得把外部业务identity与新内部资源PK混用。
- 默认TEXT；具有明确线上合同长度、定长hash/currency或范围语义的列保留明确长度/CHECK，不能不经字段契约审核扩大输入。
  所有金额/credit BIGINT及CHECK、唯一性、nullable语义、timestamp精度、partial predicate随迁移保留；JSON不承载可查询状态机真源。
- v1当前允许caller自选非UUID settlement_id、offer revision/admission输入；这些与UUID PK的切换受API_CONTRACT的B8-D2约束。
  本节不批准原地ALTER有数据环境或给v1偷偷加UUID验证。fresh install只对本任务独占空库进行。

### usage–hold：内部UUID与稳定绑定分开

Root选择在`billing_usage_event`增加可空`credit_hold_id UUID`，非空建立UNIQUE（credit_hold_id globally唯一，所有访问仍限定tenant）。
独立外部usage event可以为NULL；由hold派生的event必须在第一次创建时保存该引用，ID由应用随机UUID产生，不再拼接hold:UUID作为资源ID。
`ensureUsageEventForHold`在同一tenant/hold下返回已存event UUID，输入subject/feature/quantity/dimensions/source漂移报conflict；
它必须经Credit公开hold快照校验subject/feature与当前状态，不能只信caller source字符串。
从独立event首次绑定hold时，必须在事务内校验两方scope和业务字段，条件更新NULL→该hold；已非NULL只允许同值重放。
一个hold换另一个event或一个event换另一个hold均冲突；创建settlement必须同时确认usage_event.credit_hold_id等于本次hold；NULL首次绑定也在该事务完成。
原settlement UNIQUE(credit_hold_id)与UNIQUE(usage_event_id)继续保留，不能以两项各自UNIQUE替代event上绑定一致性检查。
不删除原UNIQUE(tenant_id,source_event_id)，来源身份不复用内部随机ID；source字段是稳定业务身份而非可换key避重的工具。

### Inbox与lease增量（唯一状态owner）

- `billing_provider_event`新增可空processing_token UUID（attempt fence），processing_attempts仍非负。其lease由唯一payment outbox拥有，不增加重复inbox lease。
  beginAttempt提交attempt/token；终态processed/ignored不可被旧失败覆盖；provider状态仍用received/processed/ignored/failed，token本身不暗示已完成。
  inbox payload/hash/tenant/provider/external event identity入库后不可变；retry只更新受控处理状态，不重解释已验证的provider身份。
- `billing_execution_event`自己是队列：增加lease_token UUID、lease_until TIMESTAMPTZ(3)、attempts INTEGER、next_attempt_at TIMESTAMPTZ(3)、
  dead_lettered_at TIMESTAMPTZ(3)与受控last_error_code；保留received/processed/failed状态，dead-letter是failed且dead_lettered_at非空。
  claim谓词为未processed、未dead-letter、next_attempt到期且lease空/过期；建立与此谓词对应的dispatch索引。
- 两outbox保留现有lease/attempt/dead-letter字段；增加attempt>=0、token/until成对为空或非空、published与dead_letter互斥等合法状态CHECK，
  具体CHECK与真实状态迁移一起复核。claim达到预算后不再执行handler；payload decode失败也经过fenced retry/dead-letter。
- 永久成功receipt/result与业务effect同提交；失败attempt日志是独立事实，不把已回滚的成功审计/业务receipt重新提交。

尚未放行：HTTP settlement/refund后续终态、Checkout durable网络恢复、全量retention/append-only数据库角色，以及breaking资源输入切换。
上述目标不声称全部数据设计已完成；下一文档/契约门须把这些关闭后才授权整体业务切换。

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

## B8-S0局部数据门

Schema、字段和当前writer不变。付款准入仅阻止尚未付款或非一次性payment事件进入既有settlement/fulfillment事务；
被忽略事件仍可持久化inbox并由outbox正常完成，但不得写payment_settlement、credit_account、credit_grant或credit_journal。
同Checkout后续paid async事件才使用原payment外部identity/inbox去重与现有账务事务；真实PG断言零提前发放和单次后续发放。
这不声称B8目标35表已经应用，也不修复其他已知事务/订阅问题。局部schema命令验证当前SQL无变化即可，不创建新migration/DDL。


## B8-D2a Checkout恢复数据增量（内部设计已审查，未应用DDL）

不增加第36张业务表；现payment_checkout→billing_checkout按B8-D1映射，由Checkout唯一writer。
以下为已有事实的生命周期所需增量，精确DDL仍只在canonical schema实现；不是第二份可编辑SQL。

| 数据组 | 目标字段/类型与理由 |
|---|---|
| 账户引用 | provider_account_id UUID引用Payment owner映射；provider/provider_account_ref与provider_environment（test/live）为已接受请求的不可变快照，不代替Payment账户authority |
| 请求身份 | provider_idempotency_key TEXT、provider_request_json JSONB、provider_request_digest CHAR(64)；快照含固定策略/API版本、完整params、关联身份与checkout_session_mode（payment/subscription），无密钥；同checkout永不改key |
| 两个截止 | 原expires_at改quote_expires_at TIMESTAMPTZ(3)；新增provider_session_expires_at可空TIMESTAMPTZ(3)，仅确认provider结果才填，二者语义独立 |
| 创建状态 | session_creation_status TEXT：not_started/in_flight/unknown/ready/failed/review_required；不替换付款业务status，ready不表示paid |
| 尝试与恢复 | session_attempts INTEGER非负；session_attempt_token可空UUID；session_lease_until/first_attempt_at/retry_deadline_at/next_attempt_at可空TIMESTAMPTZ(3)；状态机使用数据库clock_timestamp |
| 历史不确定性 | session_had_unknown BOOLEAN NOT NULL DEFAULT false，unknown记账/过期in_flight接管/同SDK调用内部传输未知时置true，永不清零，不由当前status推断 |
| 诊断 | session_last_error_code与provider_request_id可空TEXT；仅稳定安全错误/请求定位，不存完整provider错误响应、Authorization或URL查询敏感内容 |
| 已确认结果 | 既有provider_session_id/checkout_url，新增provider_session_status可空TEXT（open/complete/expired）；URL是敏感session能力，日志不输出，读取限受信owner/subject；ready后session_id不可替换 |

约束目标：provider_request_json须JSON object；digest/key非空；in_flight必须token/lease/first_attempt_at/deadline齐全；
非in_flight lease清空，attempt token保留最后身份供诊断但不具写入权。not_started要求attempts=0且token/first_attempt_at/deadline均NULL；
unknown要求attempts>0且first_attempt_at/deadline/next_attempt_at非NULL；ready/failed/review_required不留next_attempt_at。ready必须非空session_id及provider状态，
URL允许NULL（provider已complete/expired），unknown/review允许缺session ID；lease_until>本attempt领取时钟由应用检查，retry_deadline_at>first_attempt_at由CHECK兜底。
provider/account/provider_environment/checkout_session_mode/request key/digest在首次prepare后禁止修改；JSON结构按版本校验，生成Prisma不替代CHECK。CHECK要求failed时session_had_unknown=false；
flag=true后无论当前in_flight或unknown都不得按4xx转failed；合并本地SDK内部uncertainty与持久flag，旧token不能覆盖新状态。
恢复预算用first_attempt_at及持久attempts，第一次claim前可为NULL；prepare行即持久可领取，不依赖Redis/outbox提醒。
保留UNIQUE(tenant_id,idempotency_key)，新增provider账户scope下非NULL session_id UNIQUE以及provider账户scope下provider_idempotency_key UNIQUE，
scope采用非NULL provider_account_id，不用nullable external ref绕过UNIQUE。目标billing_provider_account增加provider_environment（test/live），
有效执行账户external_account_ref非空，UNIQUE(provider,provider_environment,external_account_ref)确保单一tenant映射；自身UUID供Checkout引用。
Stripe主账户同样保存实际acct身份；是否传Stripe-Account是请求配置，不用NULL代表未知账户。平台/Connect凭据以实际执行账户核验后绑定，
Checkout持久provider_account_id、环境与执行账户快照；credential轮换不得改变这些身份。此处是既有Payment表的生命周期增量，不新增第36表。

查询：tenant+id用于请求/query/finalize；跨tenant worker仅在内部固定scope扫描not_started、到期unknown及过期in_flight，
候选索引按各分支的next_attempt_at或session_lease_until+id建立partial predicate；不是对OR条件盲建单个全表索引。
worker带tenant/fence作条件更新，SKIP LOCKED与确定排序；外部查询始终tenant+subject。Payment账户关系无FK：prepare经owner同事务查询，
账户映射不得物理删除被Checkout/settlement/inbox引用的事实，停用与保留分开；reconciliation在同一只读快照通过两个owner比对orphan。

有财务效果或unknown/review/未完成session的Checkout不得物理删除，也不能清provider key/digest使旧请求重新创建。
完整保留期/法域与敏感URL清理归统一retention门，不在本轮硬编码法定年限；日志不记payload/token，清URL不清session identity和付款事实。
请求body/secret配置不入contract；quote字段与provider截止的wire改名/新增遵守API major门。此处内部字段未成为当前SQL事实。

## B8-D2c退款观察与冲正数据目标（内部设计R2已审查，SQL未应用）

与TECHNICAL_DESIGN的D2c两阶段一致；仍扩展既有35表，不新建平行退款/ledger事实源。

| 现有→目标表 / writer | 字段与约束增量目标 |
|---|---|
| payment_settlement→billing_payment_settlement / Payment | provider_account_id非NULL UUID；external_charge_ref/external_payment_intent_ref可空TEXT，仅经受信付款证据写入。账户scope下非NULL charge ref唯一，PI按账户scope索引但不先假定一PI永远只一charge；仅PI的关联需查询结果唯一且其他身份/金额一致，否则review |
| payment_reversal→billing_payment_reversal / Refund | provider_account_id非NULL UUID，external_reversal_ref非空TEXT为真正Refund.id；UNIQUE(provider_account_id,external_reversal_ref)，tenant必须与Payment账户owner一致；settlement_id引用准确付款，无FK。amount_minor正BIGINT，currency_code与付款一致；身份/金额/币种/付款关联一旦接受不可改 |
| 同上 / Refund | status区分无可信渠道证据的unknown与已接受渠道观察pending/requires_action/succeeded/failed/canceled；新事件证据仍在ProviderInbox。observed_provider_event_id/observed_at记录来源，不能用observed_at或Event.created假装资源版本；不支持的对象/状态留inbox复核，不伪造succeeded |
| 同上 / Refund | credit_effect_status=waiting_provider/pending/applied/review_required/not_applicable；credit_effect_completed_at可空TIMESTAMPTZ(3)，credit_effect_error_code可空TEXT；review_required另有review_reason_code可空TEXT以允许applied后出现渠道失败仍保留已应用状态并标review；refund级待复核由该标记表达 |
| 同上 / Refund | credit_fulfillment_id/credit_grant_id可空UUID，仅从Credit返回的精确同tenant/付款来源绑定，首次应用后不变；allocation_policy_version可空TEXT，未绑定/策略不支持不得自动apply；reason改为业务说明TEXT，不拼allocation_mode伪装结构化字段，审计actor来自受信上下文 |
| entitlement_fulfillment_reversal→billing_credit_fulfillment_reversal / Credit | 保留同一payment_reversal_id唯一；成功结果记录policy_version、input_digest、refund_amount_minor、prior_refund_amount_minor、prior_credit_micros及原G/S快照（类型/非负与正数按各自语义），让每笔delta及处理顺序可重建。amount_micros允许0；journal_id可空UUID，committed正delta必须非NULL且对应同tenant/source/负delta journal，零delta必须NULL |
| payment_outbox→billing_payment_outbox / OutboxRepository | 既有列承接RefundCreditEffectRequested(v1)，aggregate identity为Refund；去重不靠event delivery ID。与Refund pending在T1同提交，T2成功结果独立于ack，重放读取Credit结果；既有Recorded不再被误称可驱动执行 |

状态约束：applied必须有completed_at及绑定的fulfillment/grant/policy；applied后原成功Credit结果不可覆盖或删除，后续渠道失败只更新观察和review标记。
not_applicable只允许有明确“该商品无Credit效果”的可信报价/履约政策证据；缺grant、映射未到、订阅策略未定义一律不能据absence设置not_applicable。
waiting_provider是渠道未成功且无历史已应用结果；pending是已确认succeeded且具备执行输入；review_required可用于成功观察尚无可应用映射/余额不足等零Credit效果情形。
已有applied后即使渠道状态failed也不能改waiting_provider；原冲正账目在累计计算中继续参与。存在未解决review的settlement暂停新增自动效果。
源事件重放沿inbox key，记录命令重放沿receipt key；refund identity相同的不同事件不是命令payload冲突本身，状态观察可更新，金额/关联漂移另报review。

T1 ProviderEvents effect复用其外层inbox事务，不claim第二份Refund command receipt；可信succeeded观察才可同提交观察/inbox终态/唯一任务outbox。独立record root只claim自己的receipt，无可信观察时unknown+waiting_provider、零任务；已存在provider结果不被record重放降级。T2原子提交Credit全组+Refund效果状态。信用不足不回滚已提交T1；SQL异常不在同tx吞掉后补写状态。
金额额度检查在settlement锁内；失败回流后曾applied金额不从Credit累计中扣除。新外部退款请求的额度预占/取消恢复另属创建命令设计，不能复用SUM(status=succeeded)假装已覆盖在途外部退款。

退款应用查询通过tenant+id和account scope+external_ref；累计Credit已应用金额通过settlement对应Refund集合JOIN fulfillment reversal的成功结果，不能过滤渠道当前status；明确同tenant/no-orphan关系。
与Grant相关的在途hold占用为SUM(held_micros-captured_micros-released_micros)，由Credit在account/grant锁内查询；query索引按现有allocation的grant scope检查执行计划后决定，不凭字段机械加索引。
delta=0需既定身份/绑定/累计/策略检查，本退款链先前冲正耗尽的grant允许保存成功结果；不要求free余额。expired/revoked即使零delta仍review，不自动恢复权益。正delta才检查可扣状态/freeMicros/account.available及执行余额变更。
正delta同事务journal.source_kind=payment_reversal/source_ref=refund.id，序号受account锁保护；zero delta只写成功结果，禁止通过JOIN journal来判断所有退款是否已应用。

无FK关系由owner受信绑定与同事务检查保证：退款→账户/付款、效果→退款/fulfillment/grant/journal，后台Reconciliation只能经owner只读快照核orphan/金额/效果状态。
有渠道成功、pending任务、applied、review或未知事实的Refund及其inbox/receipt/履约证据不能按普通缓存TTL删除；完整retention权限策略仍待单独收敛。
本表是待编入唯一canonical SQL的目标，不声称现有VARCHAR、状态CHECK、amount>0或生成Prisma已经支持这些状态；fresh install/catalog/Prisma/真实数据演进与完整事务验证仍待实施。
