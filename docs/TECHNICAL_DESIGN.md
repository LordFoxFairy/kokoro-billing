# kokoro-billing 技术设计

## 2026-09-08 规范化状态与放置门

本文下方描述 `7a193ba` 的当前 Fastify/pg 行为，不再作为新文件的全局四层模板。目标方案见
[ADR-0003](ADR/0003-nestjs-prisma-sql-first-alignment.md)，进度唯一入口是 [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md)。
当前生产运行时尚无Nest/Prisma切换；B6a仅新增生成链与隔离Client验证，设计与生产源码差异显式保留。

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

### B5 全量 catalog drift 放置门（2026-09-08）

| 项 | 结论 |
|---|---|
| Owner | Billing 离线数据库治理；Root 设计/提交，billing_owner 单一实现 writer，数据/TS reviewer 只读 |
| 当前事实 | d062748，35 表 canonical SQL，B4 安装已验证；现有 schema 断言仅覆盖局部，无完整 drift CLI；当前工作树无源码变更 |
| 目标职责 | 以同一服务器上由 canonical SQL 新装的参照库，比对目标库结构；目标库只读，不修复、不 reset、不修改业务数据 |
| 目录比较 | 可放 scripts/ 或运行时 src/common/database/；采用 scripts/，这是安装/验收工具，运行时不反向 import；不新建目录 |
| 粒度 | catalog 读取/比较、临时参照库编排、连接生命周期、CLI 职责分开；跨文件结构类型独立，测试复用 test/integration/ 与 test/unit/ |
| 依赖 | scripts 使用 pg 与 B4 installer；目标连接 READ ONLY REPEATABLE READ、固定 search_path/UTC 与预算；管理连接只创建/清理自有随机参照库 |
| 数据/API | database/schema.sql 唯一可编辑事实源；无 API/业务 SQL/Prisma/消费者变更。参照库同实例保证 catalog 输出同版本；app 不需要 CREATEDB |
| 删除 | 不维护人工 expected schema/JSON 快照；保留已有业务完整性测试，完整比对不是其替代 |
| 验证 | pnpm db:verify-schema、lint/typecheck/build/sql:check/contract:check/test；真实 PG 正例与缺 CHECK、错 predicate、类型/default/nullability/额外对象等反例；CI 接在安装后 |

命令输入：`DATABASE_URL` 是只读目标，`SCHEMA_ADMIN_URL` 是显式管理连接（CI 指定同一实例的 postgres database），
不得隐式拿应用凭据创建数据库。管理凭据只用于自己生成、成功创建并跟踪的 `billing_reference_<random>` 数据库；
必须约束 target/admin 的实例身份（本阶段匹配 URL host/port，连接核对 server address/port/version），拒绝不同实例。
管理URL的schema/options不得污染参照库；不改角色/全局设置。目标URL重复schema参数全部检查，只支持public。
临时参照库从 template0 创建，canonical SQL 经现有 installer 安装；无 FORCE DROP、无终止非本进程 backend。
创建失败不得删除同名非自有库；finally关闭自己连接后删除自己的库，清理失败显式报错而非输出成功。连接/query/close 均有界。

比较项目：全部用户 relation 的 schema/name/kind/persistence/RLS flags，全部表列的有序名字、format_type（含 typmod）、nullability、default、
identity/generated/collation；全部 PK/UNIQUE/CHECK/EXCLUDE/FK 的定义、validation、deferrability；全部索引的定义、
predicate、unique/valid/ready 状态。约束/索引使用 pg_get_constraintdef/pg_get_indexdef/pg_get_expr，不比较 OID、统计、
数据、owner/ACL。额外用户 relation/type/routine/trigger/rule/policy 必须报告；无外键由完整约束比较保证。NOT NULL 以列属性为稳定事实，
PG18 新增约束 catalog 表示不得成为跨版本误报。对象字段排序确定，保留 SQL 字面量语义，不盲目压缩空白或小写化。
输出 canonical SHA256、服务器版本、对象数量与按对象键排列的 missing/unexpected/changed；不得输出连接串/秘密。
目标/参照数据库 encoding、locale/provider 必须比较，PG16 daticulocale 与 PG18 datlocale 明确处理。
CREATE DATABASE 返回未知时不猜测所有权 DROP，报告随机名与清理未确认状态并失败。
B5 的 scripts/schema-database-session.ts 只管理治理连接的预算、错误与关闭，不供 runtime 使用；不修改 B4 installer。
目标结构快照在单一只读事务内获取；工具验证的是该快照，不阻止不遵守部署独占协议的并发 DDL，也不检查业务数据正确性。

官方语义核验（2026-09-08）：[pg_attribute](https://www.postgresql.org/docs/16/catalog-pg-attribute.html)、
[pg_constraint](https://www.postgresql.org/docs/16/catalog-pg-constraint.html)、
[catalog 输出函数](https://www.postgresql.org/docs/16/functions-info.html)。本地 PG18 实测与 CI16 分开记录。

### B6 Prisma 生成与承接放置门（2026-09-08）

| 项 | 结论 |
|---|---|
| Owner | Billing；Root设计/提交/验收，billing_owner单一writer，独立数据与TS审查 |
| 当前事实 | 基线2a2be5a、工作树干净；B5全catalog已验收，当前无Prisma依赖/生成物/运行时调用，35表映射调查已入任务板 |
| 目标职责 | B6a先建立可重现SQL→introspection→schema/Client链；B6b验证现有账务表在Prisma同tx内typed CRUD/锁/receipt/outbox/BigInt/错误与回滚；不切生产writer |
| 目录比较 | 生成物可放根generated或src/generated；采用已批准database/generated/schema.prisma和src/generated/prisma。治理脚本选scripts而非运行时database模块，尚不创建Nest空层 |
| 粒度 | 从B5抽取真实复用的canonical-reference生命周期供drift与Prisma生成；生成进程/产物比较与CLI分工，现有目录内具名文件，无单文件业务目录 |
| 依赖 | prisma、@prisma/client、@prisma/adapter-pg固定7.10.0；CLI开发依赖、Client/adapter运行依赖。pg仍用于现有业务与治理，B6测试隔离，生产切换B8删除旧writer而非长期双栈 |
| 数据/API | SQL字节不变、无db push/migrate；Prisma model/field先保留SQL命名的确定性identity映射，生成代码不套手写TS命名规则。B8随SQL规范命名变更统一再生，不编写脆弱的正则schema重命名器 |
| 删除 | B5参照库生命周期搬至共用脚本并删原重复分支；不新建人工models/fields清单或第二schema。Client是可再生构建物不入Git |
| 验证 | frozen install、prisma validate/generate、两次刷新相同、手改schema/Client负例、全catalog无变化、lint/typecheck/build/test、源码/编译Client smoke；B6b真实事务/锁/并发/错误/BigInt门 |

B6a命令职责：`prisma:refresh`需显式SCHEMA_ADMIN_URL，只在本轮template0参照库安装SQL；固定本地CLI introspect，不读取应用DATABASE_URL。
以全新临时工作目录的空datasource+generator配置执行db pull --force，避免旧schema手改被re-introspection保留。introspection后的唯一
schema产物提交database/generated/schema.prisma，generated provenance记录canonical SHA256、schema SHA256、精确Prisma版本，禁止时间戳/秘密/临时绝对路径。
`prisma:generate`仅从已提交schema离线生成Client；不连接数据库。generator固定prisma-client、ESM、nodejs，输出路径固定；扩展名与tsc/tsx须实测。
`prisma:check`从相同canonical参照重新生成到临时目录，比较schema/provenance及当前生成Client全部相对文件与字节（missing/extra/changed），
校验失败不能偷偷覆盖现有产物；无现有Client时报明确未生成，先运行prisma:generate。refresh成功才发布新产物，不将失败的半成品当有效输出。
schema与provenance是只读生成物，构建/测试明确调用prisma:generate，不依赖隐式postinstall；CLI/子进程必须超时有界，清理自有临时目录和参照库，
不执行任意shell拼接、不把DB凭据放命令参数/日志。复用B5连接/安全资源错误；创建结果未知仍报安全随机名，不猜测DROP。

B6a允许仅为新生成代码增加精确ESLint ignore、Git ignore、TypeScript相对扩展重写及config include（确需时）；手写源码strict不降级。
不在B6替换旧架构断言，增加生成治理门证明没有production Prisma import、无手改schema来源、精确版本与无迁移/db push命令。
Docker build需复制生成配置/schema，在无数据库环境运行generate+build；不更新基础镜像/Node/全量依赖，工具链独立归B7。

B6b范围先锁定真实隔离验证，不新建production服务：test/integration/prisma-database.fixture.ts管理测试Client/adapter/事务预算，
test/integration/prisma-persistence.test.ts覆盖typed create/read/update、CHECK/UNIQUE失败与错误实际形状、同tx receipt/account/journal/outbox一起提交/回滚；
同tx参数化FOR UPDATE锁、SKIP LOCKED、不同连接竞争；BigInt超过MAX_SAFE_INTEGER存取与wire十进制边界、JSON null、UTC精度。
测试以安全隔离资源验证Prisma可承接，不把测试内mapper/error代码声称是最终业务实现；B8仍需真实模块与契约端到端替换。
raw白名单仅限fixture中明确的set_config预算、backend/tx身份断言、账务行锁、SKIP LOCKED；普通CRUD不用raw或unsafe API。

官方证据重新核验（2026-09-08）：[Prisma generator](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators)、
[db pull](https://www.prisma.io/docs/cli/v7/db/pull)、[transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)。
npm精确7.10.0三个包存在、Apache-2.0，Node ^20.19/22.12/>=24与TS>=5.4满足当前工具链；维护/退出取舍沿ADR-0003，实际安装/供应链扫描待本切片记录。

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


### B6a 收尾设计裁决

- 新增`scripts/prisma-artifacts.ts`承载生成产物比较/发布，而不是塞入Prisma进程runner；这是构建产物一致性变化原因，
  与`scripts/prisma-generation.ts`中的工具编排分离，不建新目录。发布先准备同盘副本，再备份/替换两个目录，失败逆序回滚；
  primary/rollback/cleanup错误聚合保留。destination内原子mkdir锁`.billing-prisma-artifacts-publish.lock`覆盖全过程，第二publisher立即失败。
  只有成功持有者释放锁；不自动删除疑似陈旧锁。确认没有运行者后再人工检查锁和`.backup-*`/`.next-*`；这不是跨目录崩溃原子性承诺。
  `prisma:generate`、build、refresh不得同时写同一生成目录；并发发布锁仅约束refresh publisher，不冒充整个构建系统调度锁。
- generator显式JS import扩展名；Prisma原生introspection的partialIndexes窄例外及依赖安全覆盖以ADR-0003为准。
- check/refresh均以受控安全错误输出收口；staging、参照库、发布回滚错误不互相覆盖。超时只清理本轮专属进程组，ESRCH视为已退出。
- B6a不调整生产Schema/API、业务writer、框架、既有架构门；普通CRUD/锁/事务承接继续归B6b，业务切换归B8。


### B6b 实际承接边界（2026-09-08）

隔离fixture位于现有`test/integration/prisma-database.fixture.ts`，通过canonical参照生命周期创建自己的数据库，
PrismaPg使用外部pool，由fixture先断开Client再结束pool，两者失败均保留；生产代码不import此fixture。
`prisma-persistence.test.ts`验证生成Client typedCRUD、BigInt/JSON/UTC、单事务事实组、独立连接锁与预算。
事务前后pg_backend_pid/txid相同；外连接看不到未提交账户；receipt succeeded/result、account余额、journal、outbox同事务提交或全部回滚。
同identity不同key并发与同key不同identity分开测试，避免两个UNIQUE互相掩盖；相同key/identity跨tenant允许。

| 实际操作 | Prisma7.10/adapter-pg/本机PG18.4观察 |
|---|---|
| typed create违反余额CHECK | P2039；本轮仅固定顶层code与meta对象，不推断约束名映射 |
| typed create违反key或identity唯一性 | P2002，独立因果测试 |
| 参数化raw锁等待预算 | P2010 + meta.driverAdapterError.cause.code=55P03 |
| 可解码raw statement预算 | P2010 + cause.code=57014 |
| Prisma交互事务过期 | P2028 |

P2010本身不能证明超时：Root实际无超时`SELECT pg_sleep(0)`也因void解码失败产生P2010。
预算用`set_config`返回值与具体原因断言；statement探针采用`SELECT 1 FROM pg_sleep(...)`。
Prisma timeout不是任意JavaScript callback取消器：Root双事务probe中25ms预算后150ms仍等待人为gate，释放后才settle。
因此测试并发使用可拒绝arrival、finally释放、allSettled回收，且成功路径显式await holder；不能依赖事务超时消除JS死等。
正常与早期故障反例的PID集合分开，避免依赖pool复用。此处是本版本承接证据，不是生产异常归一或重试策略的安装。

尚待B8真实业务切换：单一Credit/Ledger writer、跨模块同事务context、完整35表CRUD覆盖、deadlock/serialization恢复、
提交结果未知、外部provider副作用与worker生命周期。原始API/schema未变，不将fixture公开给业务Service或消费者。


### B7 工具链切片设计门

B7a仅运行时/测试依赖与CI配置：单一仓根.node-version为Node24.20.0，本地与CI读取它，Docker固定对应精确tag+经核验digest，
治理测试校验一致性；pnpm11.25.0固定，@types/node采用24系列最新稳定兼容精确版。Vitest5替代2，不新增生产Vite入口。
新治理测试放现有test/architecture；其他文件集、删除项与分工见IMPLEMENTATION_PLAN的B7a卡。
普通生产依赖仅精确pin现有lock实际值；Nest/Zod/Prisma等major不混入，SQL/API/业务writer不改。
release verify安装须保留测试runner原生可选包，并与CI同样执行catalog/Prisma生成门；发布安全与签名顺序保持。
B7b再收紧全部手写TS的typed lint；B7c用实际依赖图正反例替代旧modules/ports形状门；B7d独立格式化，均不制造双轨业务实现。
当前三设计面一致于“工具链无业务事实变化”，不扩大为B8生产重写授权。


B7a实施事实：本地/CI/两Docker base固定Node24.20.0与核验digest，Vitest5.0.0+Vite8.2.2强制peer由manifest/lock固定；
实际Rolldown1.2.7安装native optional binding，release不再裁剪optional。engineStrict实际拒绝Node22安装。
配置check含真实正反例，未降低现有安全阈值或跳过测试；Root完整门及Node24原生HTTP smoke证据见任务板。
本切片并未实现全部手写TS typed lint/AST边界/格式化，也未改生产模块、SQL与HTTP contract；不把runtime升级称为Nest重写。


### B7b 类型边界与门禁

B7b切片范围为已有角色文件内类型收窄、测试fixture及配置，不做业务目录迁移或SQL/API改写。
完整recommendedTypeChecked作用于所有手写TS（src/scripts/test/root配置），生成Client精确排除lint但仍由生成一致性/typecheck/build验证。
补forceConsistentCasingInFileNames/noUncheckedSideEffectImports，保留全部既有strict选项；NodeNext及dist入口不改。
non-null断言由显式事实/fixture前置条件替代，HTTP JSON以unknown+schema/实际断言收窄，不用泛型强转假验证；保留falsey异常原值和事务清理语义。
ESLint实际配置通过test/architecture/typed-lint.test.ts的正反例验证覆盖面、unsafe/Promise/穷尽性，不仅匹配配置文字。
具体版本、switch选项及允许文件由唯一任务卡冻结；三设计面一致于“无业务SQL/API变更”，完整Nest/Prisma业务迁移仍须B8设计门。
