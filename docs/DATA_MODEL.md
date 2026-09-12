# kokoro-billing 数据模型

> **B8-S4 局部实施门（2026-09-12，基线 ada75b2）**：当前扣减链路的 usage–hold 绑定先在现有唯一 writer 落地；
> canonical `entitlement_usage_event.credit_hold_id VARCHAR(36) NULL UNIQUE` 匹配当前 hold 类型，派生 event 使用独立 randomUUID。
> 同事务验证 scope/state、持久绑定及重放；HTTP 17 操作和内部方法签名不变，无新 API、FK、迁移或兼容分支。
> 当前 pg 整体事务保持，Prisma 全事务组承接仍待 M3；目标 `billing_usage_event.id/credit_hold_id UUID` 不等于当前类型已切换。
> 放置/唯一 writer/删除项/测试门详见唯一任务板 B8-S4；仅对该 P0 放行，不代替完整目标三设计门。
> S4-R2：内部 hold key/capture source/capture 与 release key 使用 Billing admission UUID；255 字符外部 invocation_id 原样保存，原 receipt 身份/digest 仍权威，不收紧 wire 上限或保留拼接 fallback。
> ensure 仅无锁校验快照和唯一绑定记录，消费权限由 settle 持锁后重验；旧全 Credit 锁图重排仍留整体事务组切换。

> **2026-09-12 当前首发裁决**：用户确认尚无真实账务数据、服务未开放；按首发clean-slate目标实施，历史数据/已发布major的待确认不再作为本轮前置。
> 不重置共享数据库、不构造历史兼容。M2a仅提前实现D1已审定且不依赖表/API的Prisma事务组件（见任务板），本仓SQL/HTTP/生产writer保持当前态；完整目标Schema与付款授权门仍按业务切片闭合。


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

## B8-R3 一致性存储与定价模型（2026-09-12目标，未应用DDL）

本节与R2共同更新D1，现有35张canonical表仍未改变。由生命周期与真实用例推导：履约两表合一、receipt三表合一、
出站投递两表合一，目标物理表数暂为31；不是以31为指标删事实。后文迁移盘点已更新，完整字段/约束仍待唯一canonical切片。

### 单一持久命令记录

采用`billing_command_receipt`统一三张同生命周期的receipt，不合入outbox或账本。比较继续分表（多份同构查询，无不同生命周期证据）
与显式scope统一表（采用）；业务命令owner仍在各feature，支持层不拥有发放/退款规则。

- 新增非空`command_namespace`，闭合集为general/payment/admission，逐一对应旧三表；非空`api_surface`当前固定internal。
  这两列由注册命令决定，不从body读取，不随模块移动改名；未来协议域增加须明确去重与切换语义。
- 唯一键为(tenant, namespace, surface, command_name, idempotency_key)；非空command_identity在相同前缀下建立partial UNIQUE。
  identity仅对确无独立业务身份的命令允许NULL；settlement/refund/admission/execution/expiry等命令在入库前强制其业务identity。
- 保留应用UUID id、versioned request digest、created_at/updated_at，以及processing/succeeded/failed/unknown语义。
  本地成功路径在一个Prisma事务中claim→effect→result；新processing不独立提交，正常失败全部回滚。历史failed/unknown/孤立processing
  不获得自动重做许可；外部操作等待状态属于Checkout等业务对象，不拿receipt充当长时队列。
- succeeded要求非空且符合该命令result schema的永久结果；SQL检查非NULL，运行时按版本解码，损坏报不变量事故。
  identity/scope/digest/成功result不可改。迁移只补scope及必要ID映射，不重算历史digest，不丢弃成功result或更换command版本绕过去重。
- 同时解析key与identity两个唯一域；分别命中不同记录时冲突，不能任选其一。恰好命中同一成功记录且identity/digest一致才重放，
  换key不重复执行；参数漂移冲突。并发约束失败后整组回滚，禁止在aborted tx里继续查询，按既定重试预算重查已提交结果。

### 单一出站投递表

采用`billing_outbox`，新增受控namespace=credit/payment；credit只是原entitlement队列的历史协议域，**不是Credit业务owner**，
Metering等事件仍由其业务owner决定。一份存储/租约实现，不新建消息总线、CDC进程或额外第八业务模块。

- id UUID、tenant、namespace、aggregate_type/id、event_type、稳定event_identity、payload_schema_version、payload_digest及payload_json
  为不可变投递身份/载荷。事件身份取版本化event_type与永久业务结果/任务ID（必要tenant），不取随机投递ID、attempt、lease或payload hash。
- UNIQUE(namespace,event_identity)防同一事件重复入队；payment另保留原aggregate_type/id/event_type的partial UNIQUE，predicate为namespace=payment。
  credit不机械套payment三元组唯一键；若未来同aggregate同type有多次合法occurrence，每次必须有不同稳定结果身份。
  同identity载荷/版本/aggregate漂移是冲突，不以ON CONFLICT更新payload解决。
- 沿用lease_token/until、attempts、next_attempt_at、dead_lettered_at与受控last_error_code，原published_at目标改为completed_at。
  completed只表示已注册handler确认本次投递完成，不表示外部支付成功，也不代表其他owner业务状态。状态由这些列推导，不再存重复status。
  CHECK要求attempts非负、lease成对、完成/死信互斥、终态无lease；payload版本为正且digest符合固定格式。
- claim以短Prisma事务和SKIP LOCKED选未完成/未死信且到期、lease空或已过期的行，并原子写入新token/lease及attempt。
  renew/complete/retry/dead-letter均比较tenant+namespace+id+token+未终态+尚有效lease；失租者不得覆盖新worker，handler结果仍靠owner幂等。
- 有界指数退避+jitter，解码失败也计入attempt；unknown handler/未注册事件不被空ack。人工重启只允许具名授权/审计命令，
  以`requeue_generation`（非负）和所观察死信状态CAS，同row同event_identity、同payload；generation递增，attempts作为本次重启周期计数归零，
  原generation/attempt/error进入同事务audit，不擦除历史。缺少旧outbox行时须从永久源事实恢复同一已注册载荷，不编造新身份。
- pending/lease/dead-letter迁移保留恢复依据；退役版本按TECHNICAL_DESIGN R3显式处置，不空ack或原位改义；暂不启用TTL删除。完成行/事件去重事实的清理须另有覆盖全部重放窗口的方案，
  不随Redis TTL删除。迁移检测历史重复/跨scope碰撞，遇不一致需受审处理，不自动选一条覆盖。

持久业务结果与投递分离：handler成功后ack丢失可重复调用，但内部handler先重放owner永久结果；外部投递只对已批准receiver承诺至少一次，
使用稳定event identity及接收方去重，不声称数据库outbox带来跨服务exactly-once。事件去向/删除清单见TECHNICAL_DESIGN R3。

### 单一按次销售价格，不保留幽灵token计费路径

依据当前admission确实用reservation_micros作为按次最终价格、token quote无生产调用的源码调查，选择当前profile为feature按次收取Credit。
这也与Root旧商业文档50 §7.5的按次方向一致，但不采用其中过期工程规范、部署结论或所有额外商业能力。
比较：保留两个混用费率路径（淘汰）、建立通用多profile引擎（当前无消费者，淘汰）、具名FeaturePrice单一销售事实（采用）。

- `billing_feature_price_revision`保存tenant内发布序列、effective_from、published_at及创建/审计引用；一次发布是一份完整且非空价目表快照，
  不是增量补丁。发布序列由同tenant事务串行分配+UNIQUE兜底；不同key并发发布仍各得不同revision，不用“冲突就当成功”。
  revision.published_at非空即不可变发布事实；revision及完整feature price集合、receipt/result、必要audit在一个Prisma事务提交。
  不先提交published revision再逐行补价；任一行校验/插入失败全部回滚，外部读者只见完整旧快照或完整新快照。
- `billing_feature_price`保存UUID id、tenant/revision引用、feature_key及unit_price_micros BIGINT>=0；UNIQUE(revision_id,feature_key)，
  同事务核tenant归属。零价必须显式发布，含义为included；缺price拒绝，绝不默认免费。
- 发布事实与feature price不可变，不保留active/disabled可变价格状态、label/model定价维度、input/output/cached费率及reservation字段。
  effective_to不再维护；在一次数据库时刻t，先选择已发布且effective_from<=t的最大(effective_from,revision)快照，再只在该快照找feature。
  revision是发布序列而非时间优先级；同生效时刻高revision胜，未来快照尚未到点不可见。缺feature不回落旧revision，避免混合价目表。
  调价/撤下单feature通过新的完整快照表达，不原位改已授权价格；本profile不另造撤销后隐式回落的API。
- Admission固定pricing_revision_id、feature_price_id、授权micros及pricing_snapshot_digest，指向不可变feature price/revision；按次quantity=1，
  authorized amount即该unit price，无token取整。快照digest含版本、tenant/feature、revision/feature price、单位及精确价格，不含当前时钟或后续状态。
  admission.created_at明确作为定价时刻，使用该事务的数据库瞬时点；selector与写入使用同一时刻，不受应用机器时钟影响。
  digest由Billing按版本生成，不接受caller digest；读取历史定价依据时按持久tenant/feature、revision ID/序号/effective_from、price ID、
  Credit单位及unit price重算，并核授权amount等于price、引用同tenant/feature，缺行或不一致报不变量错误，不回落现价。
  Capture只使用通过上述校验的原授权金额/引用，不重新查当前价格；hold/usage记录与admission绑定保持同tenant与同一价格依据。
  已成功命令仍按receipt的identity/digest/result先重放，不因当前price发布或时钟推进而重新执行账务。
- TS价格和Credit数量使用bigint及具名业务语义，wire使用十进制字符串；不经Number舍入。用于账务对账的按次数量记录1而非伪造token=0。
  Usage的model/label/meter_kind等执行归因可保留，但不是销售price key；provider成本未来若有真实需求单独明确owner与货币单位，当前不造成本表。
- 删除无人调用的UsagePricing.quote/listActive/quoteForHold、token费率/缓存token占位及对应旧factory/ports/测试；保留真实admission、
  hold/capture/release与用量归因。规则测试迁为FeaturePrice完整快照/并发/时间边界/历史授权回放，不通过删除风险断言换绿。
- account.quota_micros/quota_period没有配置、消费窗口或准入writer；目标从account/summary移除，并在major消费者切片同步Web schema/UI/fixture。
  这不删除grant赠送/订阅发放能力，不宣称当前存在完整周期quota。不把可用余额改名为quota，也不在本轮新增QuotaPolicy/Window服务。

本地消费者证据只覆盖当前检索到的代码，不能证明仓外无人调用。旧token/配额字段及当前stable v1在正式切换前保持原样；API影响见API_CONTRACT R3。

## B8-R2 核心模型裁决（目标设计，尚未应用 Schema）

本节基于当前实际writer与B8-R复审更新D1目标，而非保持旧表数的改名工程。采用业务模型驱动的模块化Billing；
不部署第二账本，也不在本轮增加税务、发票引擎或现金复式总账。以下是关系与不变量设计，不是第二份可执行Schema。

### 保留的核心事实与逻辑关系

| 事实 | 唯一职责 / writer | 不合并的原因 |
|---|---|---|
| CreditAccount | Credit：单tenant/subject积分钱包的余额投影及串行写入锚点 | 快速查询与并发控制，不代替批次和历史流水 |
| CreditGrant | Credit：来源批次、原始/剩余量、有效期和消耗顺序 | 随消费/到期变化，不能替代永久发放依据 |
| CreditHold | Credit：一次预留的状态与数量 | 预留不等于实际扣减 |
| CreditHoldAllocation | Credit：hold占用哪些grant，以及各批次确认/释放量 | 解释消费来源，避免只记一个总余额而丢失追溯 |
| CreditJournal | Credit：不可变增减事实及账户序列 | 重建与核账依据，不是可覆盖的余额字段 |
| CreditFulfillment | Credit：一次已成功发放的永久授权及结果 | 合并旧acquisition/fulfillment，仍独立于可消耗grant |

逻辑关系（由同tenant校验/唯一约束/同事务维护，不创建数据库FK）：

```text
Payment settlement / Subscription period（已冻结授权） -> CreditFulfillment
CreditFulfillment -> 精确CreditGrant + 正额grant journal
CreditHold -> CreditHoldAllocation -> CreditGrant -> CreditAccount
CreditJournal -> CreditAccount；Usage settlement -> CreditHold + Usage event
Refund -> CreditFulfillmentReversal -> 精确原fulfillment/grant及可空冲正journal
```

Money = 最小货币单位整数 + currency_code；CreditAmount = 整数micros；UsageQuantity另有计量单位。
默认一个subject一份可互换积分钱包，program是来源/政策而非余额分区；不把CRD当真实现金币种，不引入无需求的多钱包。
按次销售profile已由R3收敛，token成本不混入销售价；旧定价路径/quota字段的实际删除随实现与消费者同切。

### acquisition + fulfillment：合并为永久成功事实

比较：①继续两表（不采用，当前两个writer都同事务创建并立即committed，未见独立授权受理生命周期）；
②合并为CreditFulfillment（采用）；③直接并入grant（不采用，会把永久授权/结果与可消耗余额生命周期绑死）。
当前证据为payment/billing-settlement-service.ts:292–330与credit/subscription-grant-service.ts:53–91，位于本仓
src/infrastructure/postgres/repositories，基线fff756c；Schema当前仍保留两表。

目标`billing_credit_fulfillment`承接以下字段语义：

- 应用生成`id UUID`，对外/内部业务结果继续称fulfillmentId；tenant/subject为opaque，account/grant/grant_journal为同仓UUID引用。
- source_kind限定本profile的payment_settlement/subscription_period，source_ref为已验证的settlement/period身份；
  program_key、authorized_micros（正整数BIGINT）、effective_at/可空expires_at、
  authorization_policy_version及authorization_digest保存不可变授权；有效期非空时expires_at须晚于effective_at。
- grant_id、grant_journal_id非空且分别唯一；created_at/committed_at非空UTC毫秒瞬时点。只在发放成功事务中INSERT，
  不设置pending/failed/reversed状态：等待属于来源用例，冲正属于独立reversal事实；原成功事实不随退款改写。
- 当前一次性付款/单item订阅profile限定每个`(tenant_id, source_kind, source_ref)`只有一次发放、一个program、一份grant，
  此组合建立UNIQUE，**不把program放进可重复发放的唯一键**。同source换program/subject/account/额度/窗口/政策为冲突。
  该边界与现有journal的tenant/source/kind唯一性及D2c单grant退款一致，不为未请求的多program发行扩展账务profile。
- 先查并校验永久成功结果，再检查首次发放资格；重放不因当前报价下架、订阅取消、周期过期或grant耗尽而再发放/失败。
  digest按版本化规范化授权计算，不含投递Event ID、observed_at、当前时钟或可变provider DTO。
- 在同一个Prisma事务中验证来源授权及同tenant/account/subject，创建fulfillment、grant、正额grant journal、更新account及必要outbox/result。
  验证grant原始量/有效期与授权一致，journal的account/source/kind/amount与发放一致；UUID可预生成，不靠写入顺序替代完整性检查。
  重放直接使用永久grant/journal引用，删除旧多态source JOIN + LIMIT 1的模糊选取。

本轮只收敛已有payment/subscription履约profile；admin grant/redeem不被无证据地强制新增一套履约流程。
Subscription T1把waiting/资格/固定授权保存在period/term及outbox，不建pending CreditFulfillment；T2才与Credit全组原子提交。
退款仍按精确原fulfillment/grant和G/S快照计算，独立保存每笔CreditFulfillmentReversal；零delta也有永久成功结果、无journal。
删除acquisition表/模型/引用、重写refund/reconciliation查询、生成Prisma与对应测试必须同一闭合实施切片完成；
历史ID/数据/仓外引用处理仍受major与数据演进门约束，不据此次模型裁决直接清库。

三receipt/两outbox的物理组织由R3裁决为各一张表，显式保留去重域、状态和保留策略；不受表数指标驱动。
核心同提交矩阵见TECHNICAL_DESIGN B8-R2；API影响见API_CONTRACT B8-R2。

## B8-D1 目标映射与一致性不变量（内部设计已审查，未应用DDL）

本节为当前35表的迁移盘点，后文原表名仍为当前SQL事实；目标以B8-R2更新为准，不再要求一对一保留。
acquisition/fulfillment按R2合并；receipt/outbox及价格按R3统一，下表覆盖当前全部表去向，不创建第二可编辑Schema。
每表资源主键改`id UUID`、应用生成；同仓资源引用改对应`*_id UUID`，跨仓opaque身份保持原语义。现金`currency`列目标为`currency_code`；非现金积分单位另按R2建模，不能机械改名。
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
| `entitlement_command_receipt` | `billing_command_receipt` | database/CommandReceiptRepository namespace=general |
| `entitlement_outbox` | `billing_outbox` | database/OutboxRepository credit |
| `payment_provider_event` | `billing_provider_event` | payment |
| `payment_settlement` | `billing_payment_settlement` | payment |
| `payment_reversal` | `billing_payment_reversal` | refund |
| `entitlement_acquisition` | 合入 `billing_credit_fulfillment`，删除独立表 | credit / R2永久授权 |
| `entitlement_fulfillment` | `billing_credit_fulfillment` | credit |
| `payment_outbox` | 合入 `billing_outbox` | database/OutboxRepository namespace=payment |
| `entitlement_fulfillment_reversal` | `billing_credit_fulfillment_reversal` | credit |
| `payment_checkout` | `billing_checkout` | checkout |
| `entitlement_audit_event` | `billing_audit_event` | database/AuditAppender |
| `entitlement_offer` | `billing_offer` | checkout |
| `entitlement_offer_revision` | `billing_offer_revision` | checkout |
| `entitlement_usage_price_revision` | `billing_feature_price_revision` | metering / R3完整销售快照 |
| `entitlement_usage_price_rate` | `billing_feature_price` | metering / R3按次价格 |
| `payment_provider_account` | `billing_provider_account` | payment |
| `payment_customer_binding` | `billing_customer_binding` | payment |
| `payment_provider_subscription` | `billing_provider_subscription` | subscription |
| `payment_subscription_period` | `billing_subscription_period` | subscription |
| `entitlement_subscription_term` | `billing_subscription_term` | subscription |
| `payment_command_receipt` | 合入 `billing_command_receipt` | database/CommandReceiptRepository namespace=payment |
| `entitlement_redeem_campaign` | `billing_redeem_campaign` | credit |
| `entitlement_redeem_code_batch` | `billing_redeem_code_batch` | credit |
| `entitlement_redeem_code` | `billing_redeem_code` | credit |
| `entitlement_redeem` | `billing_redeem` | credit |
| `entitlement_billing_command_receipt` | 合入 `billing_command_receipt` | database/CommandReceiptRepository namespace=admission |
| `entitlement_billing_admission` | `billing_admission` | metering |
| `entitlement_execution_event` | `billing_execution_event` | metering |

Credit表只被Credit具名Repository更新；Payment/Refund/Metering/Subscription取得公开业务结果而非数据库model。Audit/receipt/outbox三种支持能力仅负责存储不变量，
不取得独立业务owner。payment原有aggregate_type+aggregate_id+event_type唯一性以namespace=payment partial UNIQUE保留；credit域不被暗加同一唯一性。

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
- 合并后的outbox保留现有lease/attempt/dead-letter语义，published_at改completed_at；增加attempt>=0、token/until成对、completed与dead_letter互斥等合法状态CHECK，
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

## 2. 当前 canonical 表 owner inventory

本节及随后关系/约束盘点描述当前SQL与原实现；目标物理模型以B8-R2及后续目标章节为准。

### Credit、usage 与 admission

| 表 | Owner 事实 / 生命周期 |
|---|---|
| `entitlement_credit_account` | tenant + subject 的 credit projection、held、generation 与状态 |
| `entitlement_credit_grant` | 来源唯一的 credit lot、有效期、burn priority、remaining 与状态 |
| `entitlement_credit_hold` | idempotent reservation、requested/captured/released、expiry 与状态 |
| `entitlement_credit_hold_allocation` | 一个 hold 在 grant lot 之间的分配与终态金额 |
| `entitlement_credit_journal` | account append-only delta 与稳定 sequence |
| `entitlement_usage_event` | tenant-scoped usage inbox identity、处理状态及 nullable UNIQUE credit_hold_id；派生 UUID 与来源身份分离 |
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
| `uq_entitlement_usage_event_hold` | 非空 credit_hold_id 只绑定一个 usage event；scope/state 在 owner 事务内校验，无 FK |
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

与TECHNICAL_DESIGN的D2c两阶段一致；沿用既有退款事实边界，履约结构按R2合并，不新建平行退款/ledger事实源。

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

## B8-D2d订阅数据承接目标（机制R2已审查，商业资格/SQL未放行）

保持Subscription/Credit分工，履约两表按R2合并；不把三张订阅表变成第二套Payment invoice/payment ledger。原始渠道Invoice/InvoicePayment观察保存在Payment拥有的inbox；Subscription保存本周期资格所需的不可变证据快照与来源引用，而非任意账单CRUD真源。

| 现有→目标表 / writer | 承接字段与约束目标 |
|---|---|
| payment_provider_subscription→billing_provider_subscription / Subscription | UUID id，非NULL provider_account_id，UNIQUE(provider_account_id,external_subscription_ref)。tenant/subject/checkout_id与固定offer_revision_id在可信绑定后不可因metadata事件覆盖；保存program/credit额度/币种/interval及policyVersion的报价快照与digest。subscription_item_ref、provider_price_ref初次可信校验后绑定，后续变化review |
| 同上 / Subscription | provider_status分别表达incomplete/incomplete_expired/trialing/active/past_due/canceled/unpaid/paused与unknown；last_observation_event_id、observed_at及review_reason_code用于证据。周期不在这里压成唯一current_start/end；event时间不是严格资源版本 |
| payment_subscription_period→billing_subscription_period / Subscription | UUID id，provider_subscription_id、provider_account_id、subscription_item_ref、external_invoice_ref、external_invoice_line_ref、program_key、period_start/end及固定quote/policy digest。完整身份后建行；UNIQUE(provider_account_id,external_invoice_ref,external_invoice_line_ref)和UNIQUE(provider_subscription_id,subscription_item_ref,period_start,period_end,program_key)，end>start |
| 同上 / Subscription | invoice_status/settlement_evidence_kind、source_event_id、独立证据摘要与具名JSON object快照；资金证据为受账户scope校验的InvoicePayment ID、其分配给本Invoice的amount_paid/currency及Payment settlement引用（若确有），不以PI总额冒充分配额。零额/站外等分类允许无Payment settlement，不能造正数支付。快照只保留资格所需Invoice/line标识、已校验金额/币种/数量/父关联与结清方式，不存秘密/完整客户payload；JSON version/schema受运行时验证。Invoice paid不强制附一条虚构Payment settlement，实际资金事实另经Payment能力确认 |
| 同上 / Subscription | grant_status=waiting_evidence/waiting_period_start/pending/applied/review_required，grant_error_code、grant_completed_at可空；applied要求成功Credit结果引用及授权digest，不能因provider当前状态/旧事件覆盖。waiting_period_start任务的next_attempt_at在现payment outbox，period不再复制一套lease/attempt |
| entitlement_subscription_term→billing_subscription_term / Subscription | UUID id，source_period_id唯一且同tenant；subject/program/start/end/grant_micros来自该period冻结授权。生命周期/显示状态与Credit applied分开表达，不以subscription状态覆盖历史grant额度；grant_micros非负，实际可授予数量由已批准policy决定 |
| Credit fulfillment/grant/journal / Credit（R2合并授权） | 来源统一subscription_period+period.id，基于固定授权digest重放；不读provider DTO/Subscription repository。当前profile每个source仅一个program/一次发放，按R2收紧fulfillment来源唯一性并保留journal去重；成功result校验先于当前expires/offer/订阅状态；amount/subject/account/program/window漂移冲突 |
| payment outbox / OutboxRepository | SubscriptionCreditGrantRequested(v1)按period identity唯一，payload为tenant/period/schemaVersion。只有具备批准policy与完整证据的T1可enqueue，future start通过next_attempt_at表达等待；ack丢失读成功结果恢复，不补第二份grant |

字段缺失到不能建立完整period身份时不创建占位id/window=now的周期；证据仍在inbox，沿D1记录明确缺失关联错误并有界重试/最终dead-letter，不能标ignored假装处理完毕。
同一完整period尚待付款/资格时可以waiting_evidence存在而不enqueue；新证据到达经owner重新评估同period，不换external invoice/line或Credit source identity。重开invoice与同周期不同line先review，不覆盖已applied结果。
T1复用ProviderEvents outer transaction，不新claim Subscription command receipt；Subscription事实/period+inbox终态+合格任务同提交。T2锁period/term→account→grant等，Credit全组+period/term成功结果同提交。
如果期初任务首次执行时窗口已过期，保留证据并review；成功重放跨过期仍返回同结果，数据库时钟只影响首次可发放资格，不污染永久幂等。
T1合格时now<start明确waiting_period_start+outbox next_attempt_at=start，窗口内pending，首次now>=end则review；到期handler的waiting→pending CAS与T2同事务，失败回滚不虚报pending。future等待不消费失败预算。
waiting_evidence自动补查增加next_evidence_check_at、evidence_check_attempts（非负）、evidence_check_started_at/deadline_at、evidence_generation（非负，每个接受的新证据递增）与last_evidence_check_error_code；不加第二套lease，短事务CAS推进next check/attempt后事务外GET，用attempt+claim时evidence_generation+授权digest防旧响应覆盖，provider事件使已合格/applied时不再重写。
扫描索引对已批准policy、waiting_evidence、next_evidence_check_at到期状态建立具名partial索引（实现时验证计划）；首等待deadline不被失败/重启重置。既有payment worker tick负责有界补查，12次/1小时预算耗尽显式review，清next check；新可信证据可解除仅因等待预算的review，不解除身份/政策冲突。
授权digest与证据digest分离，前者不含observed_at/Event ID等变化字段，重放输入仍保持原授权。

无FK完整性通过Checkout/Payment/Subscription/Credit公开能力验证tenant/account/subject/price/item/window/来源；账户或报价下架不是删除历史关联的授权。
查询索引对应tenant+subject+period_end/id keyset、账户scope订阅/Invoice line唯一查找、period.id应用查找；future-start调度复用outbox next_attempt索引，不新建共享Redis事实源。
Reconciliation经owner一致只读快照比对period→term→Credit授权/金额/窗口/结果，缺少invoice资金来源不靠造settlement修补。retention保留未决/已发放来源证据，保留期尚待完整设计。
本方案使用已有三表表达当前单item单服务行profile，不宣称能容纳全部通用Invoice编辑/多种资金分摊；新增商业profile如需要新事实owner/表，须独立ADR，不受“35表”数量驱动强塞字段或丢事实。


## B8-D3 权限与保留分类（目标待实施）

角色/锁/只读snapshot权威机制见TECHNICAL_DESIGN B8-D3。当前canonical没有ACL；以下当前35表清单不是已应用GRANT，也不把旧字段语义直接复制到目标。完整目标每张表与可更新列必须按D1/D2的变更重新枚举并覆盖权限门。

| 当前分类 | 表（当前物理名） | 目标注意 |
|---|---|---|
| 只发现INSERT的12表 | entitlement_credit_journal、entitlement_usage_settlement、payment_settlement、payment_reversal、entitlement_acquisition、entitlement_fulfillment、entitlement_fulfillment_reversal、entitlement_audit_event、entitlement_offer_revision、entitlement_usage_price_revision、entitlement_usage_price_rate、entitlement_redeem | 不是12表都永久无UPDATE：D2 Refund观察/status及effect需要增量状态；不可变identity/金额/结果与允许状态列分开。现有FOR UPDATE需先迁移并证明，不直接撤权限 |
| Credit可变4表 | entitlement_credit_account、entitlement_credit_grant、entitlement_credit_hold、entitlement_credit_hold_allocation | 余额/generation、remaining/status、capture/release及allocation更新；tenant/id/source/original amount受保护 |
| 回执3表 | entitlement_command_receipt、payment_command_receipt、entitlement_billing_command_receipt | 状态/result允许更新；identity/digest及永久终态回放保护，禁止因时间久清除去重 |
| 消费5表 | entitlement_outbox、payment_outbox、payment_provider_event、entitlement_execution_event、entitlement_usage_event | attempt/lease/due/处理状态允许更新，事件identity/payload与租户不可随重试重写；未决/死信不是垃圾 |
| Checkout/catalog 2表 | payment_checkout、entitlement_offer | session结果/生命周期与immutable quote/account/subject分开；配置owner决定可变字段 |
| 订阅3表 | payment_provider_subscription、payment_subscription_period、entitlement_subscription_term | 当前upsert还改subject/account/grant amount，目标D2d改不可变授权/绑定与状态分离；不能先施加不兼容ACL |
| Redeem 3表 | entitlement_redeem_campaign、entitlement_redeem_code_batch、entitlement_redeem_code | counter/status更新真实存在，不能把batch按名字当append-only |
| Admission 1表 | entitlement_billing_admission | accepted provider证据及状态有界更新；identity/授权金额/主体受保护 |
| 无当前生产writer 2表 | payment_provider_account、payment_customer_binding | 不因表存在授运行时写权；目标Payment受控配置/绑定用例批准后才授所需能力 |

初期preserve profile不清理历史账务事实、不增加TTL/归档表；R2结构合并另经数据演进门，不用retention操作代替迁移。特别保留receipt、inbox identity、payment outbox唯一身份、journal、迁移后CreditFulfillment（含原acquisition/fulfillment来源与结果）、reversal/usage settlement/redeem永久结果与历史报价；迁移前原行须完整映射，不因删表丢失，避免重复授信/扣款/冲正；无FK不替运维阻止orphan。未来维护计划必须检查双向引用、未决状态、replay范围与恢复证据，未批准不执行删除。

Reconciliation不新建第二套账本/权威投影。结果是有限一次性观察，不能拿报告重算值直接UPDATE。owner页需能查孤儿子记录、tenant不匹配、零delta无journal等目标合法关系；T1/T2待处理必须结合owner任务/截止证据，不按当前四查询把全部pending判错。

权限验收独立于35表catalog与Prisma生成：实际低权限身份读/写/行锁/事务正反例、owner成员关系/额外PUBLIC或列GRANT漂移、新表默认拒绝、生产事务在目标role下完整通过。允许UPDATE某列仍不证明状态机或tenant访问正确。
