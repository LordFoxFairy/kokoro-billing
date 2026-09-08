# kokoro-billing 技术设计

## 2026-09-08 规范化状态与放置门

本文下方描述 `7a193ba` 的当前 Fastify/pg 行为，不再作为新文件的全局四层模板。目标方案见
[ADR-0003](ADR/0003-nestjs-prisma-sql-first-alignment.md)，进度唯一入口是 [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md)。
当前尚无 Nest/Prisma 运行实现；设计与源码差异显式保留。

| 项 | 结论 |
|---|---|
| Owner | Billing；Root 负责当前文档/提交，B4 schema installer 切片派给唯一实现负责人，其他 Agent 只读 |
| 当前事实 | Fastify/pg/Zod3，35表SQL-first，17个HTTP operation；application存在大量转发，实际规则分散在pg类；子仓基线干净 |
| 目标职责 | Nest按 checkout/payment/refund/subscription/credit/metering/reconciliation 聚合；Service拥有编排，具名Repository承接复杂数据访问 |
| 目录比较 | `src/<feature>` 可行；采用 `src/modules/<feature>` 区分七业务能力与进程支持；拒绝全局机械四层 |
| 粒度 | 当前只改规范/文档；B4复用 `scripts/apply-schema.ts` 入口，提取 `scripts/canonical-schema.ts` 为安装职责，测试放 `test/integration/schema-installation.test.ts`，不新建单文件子目录 |
| 依赖 | scripts可使用当前pg驱动；src不反向依赖scripts。目标模块通过Nest公开provider协作；Prisma类型终止于database/repository边界 |
| 数据/API | SQL唯一authority，生成Prisma不成为第二可编辑schema；B4只收紧安装保护，不改表、业务事务、HTTP或消费者 |
| 删除 | 撤销旧四层强制规则；业务迁移时删除对应旧port/factory/实现，无两套writer；B4删除入口中的重复安装编排 |
| 验证 | 当前lint/typecheck/build/sql/contract/test；B4真实PG空库、非空对象、自定义schema拒绝、并发安装、失败回滚测试；完整drift/Prisma另列阶段 |

### 目标模块公开面与事务所有权

| 模块 | 唯一写入职责 | 允许依赖 / 公开能力 |
|---|---|---|
| checkout | offer/revision、checkout与provider session状态 | Catalog查询、checkout命令；provider client在事务外调用 |
| payment | provider account/customer mapping、verified inbox、settlement、payment receipt/outbox | 分派调用refund/subscription/credit公开Service；不写credit表 |
| credit | account/grant/hold/allocation/journal、acquisition/fulfillment、redeem与entitlement audit/outbox | grant/reserve/capture/release/reverse/fulfill及账本查询；在调用方同一事务scope内执行 |
| metering | pricing revision/rate、admission/execution/usage事实及对应receipt | 调用credit的事务内能力，不独立写余额/journal；保留未知执行结果 |
| refund | payment reversal与退款receipt | 退款编排调用credit reverseFulfillment，累计金额检查同事务锁定settlement；Payment查询/锁是具名内部能力，不循环注入整个PaymentProcessor |
| subscription | provider subscription/period与entitlement term | period/term查询与写入，调用credit发放；不复制订阅到账本算法 |
| reconciliation | 只读差异检测与受控调度，不自动修账 | 各owner具名检查；修复只能经owner可审计命令 |

此表是目标，不是当前 writer 已收敛的声明。35表精确命名、跨模块数据访问及无循环provider图由B6/B8切片补齐后才放行业务重写。
当前API实际装配能力见bootstrap；catalog-admin、pricing-admin、grant/redeem主要为seed/test消费，reconciliation尚无运行入口。
不因存在class就扩增HTTP surface。worker的payment/execution/expiry生命周期同属目标范围。

### B4 安装保护局部设计（不授权业务重写）

当前官方启动方式是独占Billing database的public schema。本切片明确仅支持该模式：`DATABASE_URL` 的schema参数缺省或public；
其他schema在连接前报配置错误，避免检查public却写入其他search_path。不创建/删除用户schema，不改变业务连接的既有行为。
单checked-out client、单事务，固定public/pg_catalog search_path与UTC，advisory lock后检查所有非系统schema中的用户relation
（表、分区表、view/materialized view、sequence、foreign table等）及独立用户type/function；非空即停止且不执行DDL。
空库安装失败全部回滚；同库两个安装者串行，只有一个成功，另一个看到非空并停止。无DROP/reset/IF NOT EXISTS补齐旧库。
连接/锁/statement等待必须有界，pool在所有失败路径释放。完整catalog drift是B5，不以“安装成功”冒充已完成。

实现补充：URL检查全部重复schema参数；public须真实存在且有CREATE权限。事务显式READ COMMITTED，取得advisory lock后重新
查询catalog，避免旧snapshot。设置lock/statement/idle-in-transaction预算，rollback/close失败不掩盖原始错误。advisory lock
只协调遵守协议的安装者，不阻止任意第三方DDL；目标database在安装期间须独占。扩展在用户schema中的对象也视为非空。
URI `options`中的search_path必须被安装client最终设置覆盖；验收断言对象只落public，不笼统拒绝所有合法timeout options。
安装模块无import-time副作用，CLI只读env/SQL/调用；视图、序列、materialized view、foreign table、enum/domain/composite和function
都纳入反例；系统catalog不算用户对象，relation自动派生type不重复计数。

该局部修复与当前API/SQL事实源一致，可独立验证；完整Prisma/目录重写仍受ADR-0003阶段门约束。

## 1. Owner 与边界

Billing 是一个可独立部署的 TypeScript 模块化单体，拥有 Payment、Subscription、Checkout、Refund、Credit、Ledger、
Metering、Reconcile 与 receipt。Credit 保留为本仓内部 context；Tenant/Identity 由 IAM 拥有，Run/Execution 由 Agent
拥有，ScheduledTask 由 BFF、通用调度事实由 Scheduler 拥有。跨仓引用只保存 opaque ID/受信上下文，不做跨库 JOIN。

## 2. 分层与装配

```text
interfaces/http -> application/<context> -> domain
bootstrap -> config + concrete infrastructure + interfaces
infrastructure/postgres|redis|providers|auth -> application/domain ports
```

- **Domain**：当前纯领域实现是 `domain/payment/services/billing-state-machine.ts`。
- **Application**：按 checkout、credit、metering、payment、reconcile、refund、subscription 组织 command/query/service 与窄 port。
- **Infrastructure**：PostgreSQL repository、Redis hint/lease、provider adapter、auth 与 metrics。
- **Interfaces**：Fastify route、Zod 校验、身份入口、wire mapper、envelope 与错误映射。
- **Bootstrap**：`createBillingRuntime` 是 API composition root，负责资源初始化与统一关闭。

Application 不导入 Fastify、pg、Redis 或 provider SDK；HTTP 不执行 SQL。PostgreSQL row 类型与连接只存在于 Infrastructure。

## 3. 运行单元

| 单元 | 状态 | 边界 |
|---|---|---|
| API | 已装配 | `src/main.ts`；Fastify + PostgreSQL + Redis + enabled provider |
| Payment event worker | 已实现 | `scripts/process-payment-events.ts`；持续 poll 或 `ONCE=true` |
| Execution event batch | 已实现 | `scripts/process-execution-events.ts`；单批、顺序处理 |
| Credit expiry worker | 已实现 | `scripts/expire-credit-holds.ts`；一次或 daemon 模式 |
| Schema job | 已实现 | `scripts/apply-schema.ts`；只接受空 database |
| Reconciliation worker | 未装配 | application/repository 存在，没有发布入口或 schedule |

## 4. 核心数据流

### Storefront checkout

```text
IAM user JWT 或 web-bff service-auth
  -> tenant/subject + Zod + Idempotency-Key
  -> canonicalize request -> lock tenant/key checkout -> digest conflict 或 replay
  -> 仅新 command 校验 database clock、published offer revision 与 quote snapshot
  -> 写 payment_checkout 唯一事实
  -> 可选 Stripe hosted session（稳定 provider idempotency key；当前调用仍位于 session transaction）
  -> 返回 snake_case checkout snapshot
```

同一 `tenant_id + idempotency_key` 重放读取原 checkout；报价在首次成功后被 disabled 也不改变 replay。`quote_hash` 是带 command
version 的 SHA-256 digest，覆盖 subject、offer revision、金额、currency 与完整 quote snapshot。Object key 递归排序、array 顺序保留，
非 JSON 值拒绝；digest 不同返回 `billing.idempotency_conflict`。

### Admission / usage

```text
Agent|Model|Studio service
  -> admission command receipt
  -> tenant-scoped price revision
  -> included: admission captured
     credit: lock account/grants -> hold + allocations -> update account projection
  -> accepted receipt: usage event + settlement + debit journal + outbox
     explicit failure/rejection: release hold
     unknown: retain hold for later reconciliation
```

`entitlement_billing_command_receipt` 是 authorize/capture/release/execution-event ingress 的 durable replay authority。Receipt scope 是
tenant + API surface + command + key；authorize identity 是 invocation ID，capture/release identity 是 admission ID，execution-event
identity 唯一选择 event ID。Release 的 invocation/reason/service receipt 与 execution event 的完整 envelope 都进入版本化 canonical digest。
每个 handler 在检查 admission/event 终态前先核对 receipt；Redis hint 失败时请求继续到 PostgreSQL。

### Provider event / payment fulfillment

```text
provider signature + provider account mapping
  -> payment_provider_event inbox + payment_outbox
  -> worker row lease
  -> normalized provider event
  -> settlement/reversal/subscription grant application path
  -> published / retrying / dead_lettered
```

Provider call/verification 不在持有账务事务时执行。外部 event 使用 provider + external event ID 去重。

Webhook ingress 只承认 production registry 的 `stripe|alipay|wechat`。Stripe/WeChat 从 provider header 验证 raw JSON；Alipay
从同一份 form-urlencoded raw body 解码并验证 `sign`/`sign_type=RSA2`，query 参数和 fixture signature 不进入 runtime contract。

### Settlement acceptance

```text
payment-worker|scheduler + tenant + Idempotency-Key
  -> strict body / normalized command
  -> lock-or-create payment_command_receipt
  -> reconcile idempotency key + settlement_id identity + request digest
  -> write settlement + payment outbox
  -> persist exact acceptance result
  -> commit / replay persisted result
```

`payment.settlement.accept` 的 command identity 是 `settlement_id`。Receipt key 与 identity 各有 tenant/command scoped unique
constraint；payload drift、key 指向另一 identity，或 identity 指向另一 payload 都不会进入业务写入。

### Refund acceptance

```text
payment-worker|admin + tenant + Idempotency-Key
  -> resolve provider and lock settlement
  -> INSERT payment_command_receipt ON CONFLICT DO NOTHING
  -> lock key-or-(provider, external reversal ref) identity receipt
  -> compare versioned canonical digest / replay durable result
  -> validate cumulative amount -> write reversal/audit/outbox -> finish receipt
  -> one transaction commit
```

`PaymentReversal` 的业务 identity 是 provider + external reversal reference 的 canonical digest。Settlement row 使用 `FOR UPDATE`，
因此不同 refund identity 的累计金额检查和相同 key/identity 的两个独立连接都被串行化；唯一约束竞争不会泄漏为 500。

### Expiry

```text
scheduler + tenant + Idempotency-Key + batch_id
  -> normalize limit
  -> lock-or-create entitlement_command_receipt
  -> reconcile key + batch identity + request digest
  -> stable scan + lock hold/allocation/account
  -> release projection + write outbox
  -> persist exact expired hold IDs
  -> commit / replay persisted result
```

Expiry worker 先尝试 Redis lease，但 lease 只减少并发工作，不是过期或余额事实。`entitlement.credit-holds.expire` 的 identity 是
caller/worker 生成的 `batch_id`；一次 daemon tick 生成一个新 identity，一次性重试可显式复用
`BILLING_EXPIRY_BATCH_ID`。同 key 不能绑定下一批，同 batch 换 key 仍重放原结果。

## 5. 事务与并发

- `PostgresConnection` 通过 `AsyncLocalStorage` 将一个 request/worker operation 绑定到一个 session；嵌套事务使用 savepoint。
- Repository SQL 使用 PostgreSQL `$1...` 参数；动态 outbox table 只来自封闭 union。
- 写路径按 tenant-scoped receipt/事实、聚合、allocation/journal、outbox 的固定业务顺序锁定。
- Admission command receipt/effect/result、settlement receipt/settlement/outbox/result、refund receipt/reversal/outbox/result，以及 expiry
  receipt/选中 hold 的 allocation/account/outbox/result，分别在一个 use-case transaction 内提交；内部 savepoint 不改变外层原子性。
- 三张 receipt 表受 tenant/operation/key unique；具备业务 identity 的 command 另受非空 identity partial unique。`ON CONFLICT` 后的
  tenant-scoped `FOR UPDATE` 串行化并发重试。
- Receipt 的 `processing` 只表示当前 transaction 内的 claim；当前模型不提交 processing lease，也不 reclaim。历史可见
  `processing|unknown` 稳定返回 `billing.command_unknown`，`failed` 返回 `billing.command_failed`。
- Payment outbox 使用 `FOR UPDATE SKIP LOCKED`，lease 更新使用独立连接，避免与 handler 事务一起回滚。
- 无数据库 FK；Application/Repository 通过 tenant existence、state check、row lock、同事务写入、UNIQUE/CHECK 与 reconciliation
  维护关系。
- Cursor 使用稳定复合排序；credit ledger 绑定 tenant、subject、created time、sequence 与 ID。

## 6. 状态与不变量

- Admission：`created -> held|rejected|unknown`，`held -> captured|released|unknown`；captured/released/rejected 为终态，unknown
  只可向 captured/released/unknown 收敛。
- Credit：`available_micros >= 0`、`held_micros >= 0`；hold allocation 的 captured + released 不超过 held。
- Grant：remaining 在 `[0, original]`；按 expiry、burn priority、issued time、ID 的稳定顺序分配。
- Journal：append-only；每 account 的 sequence 唯一，每 source/kind 事实唯一。
- Checkout/settlement/reversal：金额为正、currency 为三位大写；外部 provider identity 唯一。
- Unknown outcome 不被当作成功或失败；保留事实并进入重试/对账路径。

PaymentCollection/PaymentAttempt 的纯迁移表已有 unit test，但当前业务 repository 未调用这两组断言；Admission 迁移由 repository
调用。该差异属于后续领域收敛工作，不在本阶段修改。

## 7. 错误与关闭

Transport 将已知 `billing.*` 错误映射到 4xx/409/402，其余归一为 `billing.internal_error`，并补齐 retryable/details 与
request ID。损坏的 durable result 使用 typed persistence invariant：外部只见 generic 500，结构化日志保留内部 code。API 在
SIGTERM/SIGINT 时关闭 Fastify、Redis 与 PostgreSQL，默认总 deadline 为 10 秒；超时退出非零。Redis 初始连接失败时 API 仍启动，
`/readyz` 在 PostgreSQL 健康时返回 ready + `redis=degraded`；expiry worker 同样直接执行 PostgreSQL-protected batch。
Payment worker 续租失败返回 `lease_lost`，handler 失败按 attempts backoff，达到上限写 dead-letter。

详细 timeout、降级和恢复语义见 [`RELIABILITY.md`](RELIABILITY.md)。

## 8. 已知设计缺口

完整列表见 [`CURRENT.md`](CURRENT.md)。核心 command durable receipt 与 webhook provider contract 已闭环；剩余直接影响技术闭环的是：其余 OpenAPI shape/历史 breaking 比较不完整、
reconciliation 未装配、execution batch 无跨进程 lease、HTTP overall deadline/size/rate limit 未显式配置，以及 production
observability/DR 证据缺失。Hosted checkout provider call 仍位于 session transaction，未宣称已完成外部调用事务分离。
