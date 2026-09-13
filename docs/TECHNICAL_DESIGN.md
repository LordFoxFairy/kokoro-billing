# kokoro-billing 技术设计

## B8-M1 canonical 模型切片实施决定（2026-09-13）

本轮仅落实已审R2/R3/D2目标canonical与只读Prisma，字段/约束唯一设计见[DATA_MODEL的M1决定](DATA_MODEL.md#b8-m1-canonical-模型切片实施决定2026-09-13)。当前v1机器合同及Fastify/pg仍是旧运行时；新Schema是完整切换的非部署中间态，不代表旧HTTP已适配，也不改HTTP权限、字段、状态或消费者。完整业务切换仍须目标机器契约与全部writer/consumer同时闭合。首发无真实数据不授权清库；禁止兼容表/view/第二canonical。本次授权仅离线Schema/生成/约束验证，不把局部文档门当作生产重写放行。



> **B8-S4 局部实施门（2026-09-12，基线 ada75b2）**：当前扣减链路的 usage–hold 绑定先在现有唯一 writer 落地；
> canonical `entitlement_usage_event.credit_hold_id VARCHAR(36) NULL UNIQUE` 匹配当前 hold 类型，派生 event 使用独立 randomUUID。
> 同事务验证 scope/state、持久绑定及重放；HTTP 17 操作和内部方法签名不变，无新 API、FK、迁移或兼容分支。
> 当前 pg 整体事务保持，Prisma 全事务组承接仍待 M3；目标 `billing_usage_event.id/credit_hold_id UUID` 不等于当前类型已切换。
> 放置/唯一 writer/删除项/测试门详见唯一任务板 B8-S4；仅对该 P0 放行，不代替完整目标三设计门。
> S4-R2：内部 hold key/capture source/capture 与 release key 使用 Billing admission UUID；255 字符外部 invocation_id 原样保存，原 receipt 身份/digest 仍权威，不收紧 wire 上限或保留拼接 fallback。
> ensure 仅无锁校验快照和唯一绑定记录，消费权限由 settle 持锁后重验；旧全 Credit 锁图重排仍留整体事务组切换。

> **2026-09-12 当前首发裁决**：用户确认尚无真实账务数据、服务未开放；按首发clean-slate目标实施，历史数据/已发布major的待确认不再作为本轮前置。
> 不重置共享数据库、不构造历史兼容。M2a仅提前实现D1已审定且不依赖表/API的Prisma事务组件（见任务板），本仓SQL/HTTP/生产writer保持当前态；完整目标Schema与付款授权门仍按业务切片闭合。


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
| checkout | offer/revision、checkout与provider session状态 | Catalog查询、checkout命令；只读依赖Payment核心账户查询（B8-D2a）；provider client在事务外调用 |
| payment | provider account/customer mapping、verified inbox、settlement；receipt/outbox经唯一数据库支持写入 | 核心不依赖其他feature；事件编排子模块显式导入其他owner，详见B8-D1；不写credit表 |
| credit | account/grant/hold/allocation/journal、fulfillment/reversal（R2合并授权）、redeem；audit/outbox经共享支持写入 | grant/reserve/capture/release/reverse/fulfill及账本查询；在调用方同一事务scope内执行 |
| metering | feature price revision/price、admission/execution/usage事实及对应receipt | 调用credit的事务内能力，不独立写余额/journal；保留未知执行结果 |
| refund | payment reversal与退款receipt | 退款编排调用credit reverseFulfillment，累计金额检查同事务锁定settlement；Payment查询/锁是具名内部能力，不循环注入整个PaymentProcessor |
| subscription | provider subscription/period与entitlement term | period/term查询与写入，调用credit发放；不复制订阅到账本算法 |
| reconciliation | 只读差异检测与受控调度，不自动修账 | 各owner具名检查；修复只能经owner可审计命令 |

此表是目标，不是当前 writer 已收敛的声明。全部当前表的保留/合并/删除映射、跨模块数据访问及无循环provider图由B6/B8切片补齐后才放行业务重写。
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

## B8-R3 一致性支持、销售定价与实施顺序（2026-09-12目标）

R2保留的Credit核心事实不变。本节裁决剩余两处模型分叉；具体字段/约束以DATA_MODEL R3为目标入口，机器SQL尚未切换。

| 放置门 | 决定 |
|---|---|
| Owner / 当前事实 | Receipt与outbox由Billing一致性支持唯一存储writer管理，不是新业务owner；当前三receipt/两outbox字段同构，真实差异是去重scope/事件唯一性 |
| 位置比较 | 继续src/database下具名CommandReceiptRepository/OutboxRepository（采用）；每feature各复制同形实现（淘汰）；新建消息总线/通用command框架（无独立需求，淘汰） |
| 粒度 / API | 一个receipt model、一个outbox model；具名claim/replay/complete和enqueue/claim/renew/complete/retry方法，不接受任意表名/SQL；业务result验证由已注册命令schema定义 |
| Metering职责 | FeaturePricingService拥有完整销售价目表的发布/选择及授权快照；BillingAdmissionService拥有准入编排；Credit仍唯一执行预留/扣减/释放；不把所有规则堆进Metering Repository |
| 目录比较 / 删除 | src/modules/metering内feature-pricing具名service/repository/schema（采用）；继续UsagePricing混合token/按次同名层（淘汰）。删除被替代factory/ports/旧报价路径而非另包wrapper；只在切片时建实际文件 |
| 依赖 / 数据 | 来源feature决定command/事件语义→一致性支持；Metering→Credit单向。同Prisma tx，SQL-first从完整目标canonical只读生成Client，不改写生成模型补规则 |
| 验证 | scope交叉碰撞、并发重放/深层回滚、失租晚完成、重复事件载荷漂移、旧pending恢复；价格完整快照/生效边界/零价/缺价/历史结算，消费者删除quota须同切 |

### 存储合并不改变业务身份

Receipt将general/payment/admission从物理表选择改为固定命名空间列，api_surface当前固定internal。两唯一域同时解析，
同key/identity串错行必冲突，成功result永久且可按原身份回查。module改名不改变已发布命令namespace或digest。
Outbox将credit/payment从表选择改为namespace，保留payment三元组partial UNIQUE与稳定event_identity；
原published_at目标称completed_at以表达内部handler完成。重试/死信/lease状态从列推导，不另存重复status/kind/topic。
受控registry按(namespace,event_type)提供payload decoder、handler/receiver、超时和公平调度预算，不能从payload选择任意函数。

### 事件路由闭合与删除门

| 当前/已设计事件 | 稳定身份 / 目标接收方 | 本轮裁决 |
|---|---|---|
| PaymentProviderEventReceived | provider inbox UUID + 事件版本 / PaymentEvents.process | 保留；来自已验证inbox，内部handler再次核tenant与attempt fence，成功重放不重复效果 |
| RefundCreditEffectRequested | Refund UUID + 事件版本 / Refund.applyCreditEffect | 按D2c在可信渠道成功及精确绑定后enqueue；record accepted本身不触发扣账 |
| SubscriptionCreditGrantRequested | period UUID + 事件版本 / Subscription.applyPeriodGrant | 按D2d资格/窗口及固定授权调度；商业资格待批准时不凭active/trialing发放 |
| PaymentSettlementRecorded / PaymentReversalRecorded | 当前纯记录通知，没有现生产handler | 不把它们作为已实现自动履约承诺；major切片须以明确owner effect任务替换或删emit，终态查询与HTTP语义同切，禁止空handler ack |
| EntitlementFulfilled/Reversed、UsageSettled、UsageHoldReleased/Expired、CreditGrantExpired及其他仅通知事件 | 永久fulfillment/reversal/settlement/hold/grant/redeem结果身份 | 目前没有已确定外部receiver的通知不新建万能dispatcher；实施前完成消费者盘点，无消费者emit随切片删除。若确认外部receiver，先冻结event contract与接收方去重，再保留对应单目的路由 |

删除未来emit不等于丢弃历史投递：切换前暂停并排空旧worker，按namespace/type/identity/digest盘点未完成、租约和死信行，旧事件版本不得原位改成新effect任务。
有批准receiver的保留原版本处理；确认仅冗余通知且永久owner事实完整的，由具名迁移决定将原行保留为死信、last_error_code=delivery_retired_by_migration，
清lease并写同事务审计（版本、原因、数量与原状态），completed_at保持NULL，不冒称送达、不进入unknown重试。该原因禁止普通requeue；重新启用须另审receiver/版本与原效果。
不能证明旧事件用途、owner事实完整性或停止旧worker时，阻断该数据切换并保留待审，不自动删行。不存在真实数据的fresh install不伪造此迁移过程。

现有provider requeue在冲突更新分支**没有修改payload_json**；初始INSERT与缺行重建的载荷构造不同，不能据此声称旧行载荷被覆盖。
新实现仍须禁止同identity载荷变化，并从永久source恢复缺行时使用唯一canonical事件构造。重启同row、审计generation/CAS，不删除重插绕过去重。
队列公平性按已注册任务分别限制每tick预算，避免provider事件持续堆积饿死Refund/Subscription；未知任务解码/重试有界，终态和人工恢复可观测。

### 完整设计门剩余的可信付款账户问题

Root额外复核发现当前billing-admission-service.ts:220–223用billingSubject.ref选CreditAccount，payerRef主要进入记录/幂等比较，
而HTTP允许user/project/organization/service等使用主体。使用主体不等于付款主体；保留这个映射直接换Prisma仍可能选错钱包。
R4必须冻结：付款主体来自哪种受信身份/委托凭证、哪个owner授权其为该invocation付费、同tenant账户与消费主体怎样绑定，以及拒绝/重放语义。
禁止以任意body.payer_ref、project/runtime/workspace ID或仅service认证成功直接选择扣款账户；无有效付款授权时不扣款、不猜fallback。
这是完整机器契约/业务实施门的未闭合项，不影响R3一致性支持/价格结构裁决，但本文件尚未宣布整仓技术方案全部通过。

### 定价决策及消费者边界

保留当前真实按次销售语义，FeaturePrice只按tenant/feature选择；meter_kind/requested_model_tier/model attribution是执行或审计信息，不是隐式定价键。
发布完整价目表快照，以一次数据库时刻选择最大(effective_from,revision)再找feature；禁止每feature回落旧revision。
显式零价included、缺价拒绝；Credit金额bigint、wire十进制字符串，历史capture从授权快照结算而不重新报价；Billing对历史price/revision引用及精确金额重算digest，缺行/漂移报不变量错误，不信任caller digest。
当前无生产消费者的token quote/费率壳删除，不改名冒充provider成本；成本分析将来另以真实owner/profile设计。
quota只有Web展示无配置/扣减writer；schema/summary删除与Web消费者同major切换，不以“暂无writer”单独删字段破坏现有页面。

成熟依据（2026-09-12）：[AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
说明本地业务与事件记录原子提交、投递可能重复及接收方幂等；[Debezium outbox](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
提供事件身份/aggregate/payload的明确分离。这里只采用可核验语义，不部署其CDC/Kafka栈；统一表数/namespace与当前按次profile是Kokoro裁决，不是品牌保证。

## B8-R2 核心事实与框架事务边界（目标设计）

跨仓实现约定只维护在Root [TypeScript手册§12.1/12.2](../../docs/kokoro-handbook/standards/08-typescript-backend-engineering.md#121-事务)。
Billing固定Prisma 7.10.0的`$transaction(async (tx) => …)`负责提交/回滚；下文TransactionService只是同一client与trusted scope的薄上下文provider，
不是手写BEGIN/COMMIT的事务引擎。Redis仅辅助协调/缓存，唯一约束及持久receipt/业务结果是最终幂等依据。

| 设计项 | 放置与裁决 |
|---|---|
| Owner / 当前事实 | Billing / Credit唯一发放writer；现有两张acquisition/fulfillment表由payment与subscription两个pg类同事务创建，application主要转发 |
| 目标职责 / API | 一个永久CreditFulfillment保存授权和成功grant/journal引用；Credit公开fulfill能力返回业务身份，其他模块不写Credit表 |
| 位置 / 粒度 | 选既定src/modules/credit内具名履约Service与复杂查询Repository；淘汰payment/subscription各保留发放实现及shared通用授信框架。不是新一级模块，不逐表生成Service |
| 依赖 / 生命周期 | 来源owner验证资格并冻结授权→Credit；Credit不反向查Payment/Subscription Repository。所有effect加入最外层Prisma事务，无渠道网络调用 |
| 数据 / 删除 | DATA_MODEL R2定义两表合并及source唯一性；删除旧acquisition模型/写入/模糊JOIN和同名application转发，Prisma从唯一SQL再生；不保留读新写旧 |
| 验证 | 完整canonical/catalog/Prisma生成、同source改program冲突、深层回滚、并发发放、成功跨过期重放、退款含零delta、订阅T1/T2及orphan；当前仅文档裁决，尚未执行新模型测试 |

Credit内部按余额/账本、预留/结算、履约/冲正、兑换的实际职责拆具名能力，不用一个万能CreditService承接全部规则。
保留account/grant/hold/allocation/journal；永久发放依据与可消耗批次分开。两张履约表合并是生命周期裁决，不是单纯少一张表。

| 用例 | 同一个Prisma事务内 | 事务外 / 独立阶段 |
|---|---|---|
| 已验证付款发放 | 来源结果/幂等校验→CreditFulfillment + grant + grant journal + account + 必要outbox/成功result | 支付平台验签/查询/网络调用；不从付款金额猜Credit额度 |
| 预留 | 固定价格/授权→admission + hold/allocation + account投影 + receipt/result | 执行服务调用；included模式不建虚假hold |
| 确认或释放 | 先校验identity/digest→hold/allocation/grant/account效果 + 必要journal + usage/admission终态 + receipt/outbox | 重复事件可重投，但同一业务效果只生效一次；unknown不盲扣/盲释放 |
| 退款冲正 | 锁定原付款/退款及Credit范围→独立reversal结果 + 精确grant/account效果 + 正delta对应负额journal + effect状态/result | 渠道观察是独立事实；零delta保留结果但不写零流水 |
| 订阅周期发放 | T2：period/term + 固定授权下的fulfillment/grant/journal/account + effect状态/outbox | T1先保存资格/证据/待发任务；等待状态属于Subscription，不预创建pending fulfillment |

同提交范围仍按D1确定锁顺序/namespace、D2处理外部恢复。付款/订阅当前profile每source一个program/一次履约，
不扩未请求的多program发放。HTTP接受事实与Credit效果分开，不把Redis命中或202当成扣款已完成。
原D1目录及事务原则保留；表形状由DATA_MODEL R2/R3更新，统一receipt/outbox后目标31表，完整canonical待闭合。

## B8-D1 业务模块与事务目标（2026-09-10，内部设计已审查）

基线`ce5b6285e14e61f97dc16d1dd9d7dbc553358e66`，生产仍Fastify/pg。以下替代前文粗粒度目标表中尚未决定的共享writer与循环编排描述，
不改变下文标明的当前实现。整体业务重写仍须B8-D2契约/切换决定与机器Schema闭环；本节不是生产实施授权。

### 模块公开面与无环装配

唯一业务根为`src/modules/`下七个feature。公开入口为各`<feature>.public.ts`，显式导出业务Service、纯业务input/result与Nest module；
不公开Repository/ORM类型，不使用export-star、forwardRef、动态ModuleRef查找或全局业务provider绕过依赖方向。

| Feature | 可导入的其他feature公开面 | 唯一writer / 公开职责 |
|---|---|---|
| checkout | payment核心（仅账户只读能力；B8-D2a修正） | Offer/Revision、Checkout；catalog查询、发布、checkout claim/finalize；provider session client是本模块内部网络适配器 |
| payment（核心） | 无 | ProviderAccount/CustomerBinding、ProviderInbox、Settlement；映射查询、接受支付事实、settlement锁定快照、受控inbox重试 |
| credit | 无 | account/grant/hold/allocation/journal/fulfillment/reversal/redeem（履约见R2）；预留、扣除、释放、发放、冲正、到期及账户/账本查询 |
| metering | credit | price revision/rate、usage event/settlement、admission、execution inbox；定价与执行计量，绝不直接写Credit表 |
| refund | payment、credit | reversal接受与累计退款额度；调用Payment公开的锁定settlement快照，再调用Credit冲正，不取得Payment Repository |
| subscription | payment、checkout、credit | provider subscription/period/term；解析受信provider/报价关联并通过Credit发放 |
| reconciliation | 上述六owner | 一致只读快照中的差异检查；仅经具名owner命令申请重试，不自动修改账本或猜测缺失数据 |

Payment provider-event编排置于`src/modules/payment/provider-events/`，这是Payment内确有processor/handler/worker装配的子能力，不是第8业务模块。
其`PaymentEventsModule`导入Payment核心、Checkout、Refund、Subscription、Credit；HTTP/worker组合根按需要导入它。
Payment核心与`payment.public.ts`均不反向导出/导入此编排子模块，Refund/Subscription只依赖Payment核心，避免通过barrel重新闭环。
`reconciliation`仅调用Payment核心受控requeue而不导入事件processor。

框架支持按真实职责放`src/config/`、`src/database/`、`src/http/`、`src/health/`；auth/logging/cache/worker在对应切片给出具体文件集，
不预建空目录。对比全局四层与feature容器，选后者是为了让每个业务用例和其测试/持久化归同owner；不是简单批量搬目录。
HTTP和三个既有worker最终都用Nest显式生命周期与同一owner能力，schema/生成治理脚本不进入运行时依赖图。

### 共享一致性支持：唯一物理写入者

`src/database/`拥有Prisma连接/事务生命周期以及以下具名一致性存储组件；它不是另一个业务owner，也没有通用BaseRepository或任意execute。
业务模块只提供operation、身份、digest、审计语义和事件语义；存储层不解释折扣、信用额度、退款或订阅规则。

| 组件 | 固定数据scope与能力 | 约束 |
|---|---|---|
| CommandReceiptRepository | 单表，固定general/payment/admission namespace；claim/replay/complete | tenant+namespace+surface+command下key/非空identity双唯一性；成功result不可覆盖，损坏报内部不变量 |
| AuditAppender | 唯一audit表的append | trusted actor、operation、resource ref；成功审计与业务同一提交，不在回滚后伪造成功 |
| OutboxRepository | 单表，固定credit/payment namespace；enqueue、claim、renew、complete、retry/dead-letter | R3保留不同去重约束；payload/identity不可变；状态写比较scope+tenant+ID+token+未终态+有效lease |

public业务API不接收以上Repository或Prisma TransactionClient。它们由各模块内部Service注入，所有业务写显式从当前事务上下文取client。
每表唯一写入者用真实Prisma model访问/调用图和Nest provider图检查，不以类名、目录或interface数量作为证明。
seed最终通过各owner同一写入Service执行，不保留seed脚本中的第二套业务INSERT；不会因此扩展HTTP入口。

### 一个最外层事务，嵌套失败必须整组回滚

`TransactionService.run(scope, callback)`只在最外层开启Prisma交互事务，嵌套调用加入同一client；Service决定边界，Repository没有提交权。
scope包含受信tenant/actor与operation，不从body覆盖；ALS上下文记录transaction state（active/rollback-only/closed）。
嵌套调用必须在callback前比较tenantId与outer完全相同；不一致先标rollback-only再抛context-mismatch，callback零调用、两个tenant都不得写入。
root actor与command identity在整个事务不可变；子能力只追加child operation观测信息，不覆盖root scope。若嵌套传入actor则必须与root一致，否则同样拒绝。
嵌套run抛错时先将上下文设rollback-only再传播，外层即使catch也不得提交；本方案不引入SAVEPOINT，不将Prisma nested transaction当savepoint。
上下文用独立hasRollbackCause标志保存firstRollbackCause（unknown），不是按truthy判断；false/0/null/undefined等throw也保留。
outer callback正常返回但已rollback-only时重新抛首个cause触发回滚；后续错误、rollback或cleanup失败不得覆盖首因，使用带primary/cause的聚合错误附加清理故障。
测试必须覆盖outer吞掉内层错误、falsey throw、多个错误顺序和cleanup再失败，而不是只检查某个泛化rollback-only字符串。
所有跨模块公开mutation都经此run边界，禁止嵌套开启新的root command/receipt。Credit内部事务能力只产生账务effect，不重复声明外层command receipt。
各owner明确分开root command入口与transaction-bound effect入口；Provider事件编排调用Refund/Subscription/Credit的effect入口，不间接claim第二个root receipt。
公共查询分普通root read与transaction-required read/lock；所有在active上下文内执行的查询都使用当前transaction client并核对tenant，不能悄悄落回root PrismaClient。
锁定settlement/hold等能力必须requireActiveTransaction(expectedTenant, write)，外部无事务、closed或tenant不匹配均在SQL前失败。
reconciliation的owner snapshot查询必须requireActiveTransaction(expectedTenant, readOnlySnapshot)，只能加入同一READ ONLY REPEATABLE READ上下文，不各开事务。
普通root read只有在没有事务上下文时才允许root client；这些模式检查与client选择同属TransactionService，不在各Repository复制fallback分支。
生命周期结束后立即关闭上下文；后续异步任务使用旧client报上下文错误。typed lint拒绝floating promises，测试补脱离await/跨tenant/已关闭client反例。

外层确认回滚后，才可对明确可重放且无外部副作用的完整命令做有限重试。P2034、serialization/deadlock按实际错误形状分类；
P2002不通用重试，只有已登记的并发claim竞态才允许整个命令回滚后重试/读取已提交receipt。禁止在aborted transaction中继续查询。
成功receipt解码失败、业务冲突、提交结果未知不重跑扣款；transient失败不永久写failed receipt占死原key。

配置目标：maxWait=1000ms、单次交互事务=10000ms、statement=8000ms、lock=1000ms、idle-in-transaction=10000ms，
整个可重试命令预算20000ms、最多3次、指数退避起点25ms/上限250ms并带jitter。它们是待实测默认，不是SLO实绩；
每次尝试与sleep受剩余总预算/取消信号约束，连接/lock/statement/事务deadline分别归类；HTTP/worker外层预算必须容纳该命令预算并在config校验。
UTC和public/pg_catalog search_path由每事务固定配置，不靠角色默认值。网络调用禁止发生在账务事务中。

### 事务组与锁顺序

先取得当前命令的去重namespace锁（key/identity同时存在时按确定排序），再claim/replay receipt；这些锁只协调本用例，不替代UNIQUE。
同一事务中资源的顺序固定为：根业务资源 → Credit account → Credit grants（ID升序）→ holds/allocations（ID升序）→ append-only结果。
需要根据hold定位account时先无锁tenant限定查询，再锁account、重新读取并校验hold；expiry不得先锁hold再倒拿account。
多账户按account ID排序；grant消费优先级决定分配算法，不改变锁获取顺序。跨feature禁止从Credit反向获取Metering/Payment/Refund锁。

| 事务组 | 根资源与同提交写入 | 分离生命周期 |
|---|---|---|
| catalog/pricing发布 | receipt；offer或tenant pricing namespace锁；feature price revision/price、audit、result | FeaturePrice完整发布在tenant advisory锁后才分配MAX+1，保留UNIQUE；不同合法key必须都成功 |
| grant/redeem/subscription发放 | receipt或inbox；campaign/code或subscription/period；Credit全组、term、audit/outbox/result | 无provider网络；来源唯一性防同一period/payment/redeem重复发放 |
| authorize | admission receipt、invocation/admission；Credit account/grants/hold/allocation；admission/outbox/result | 定价快照属于Metering；included模式不虚构Credit hold |
| capture/release | receipt、admission；usage绑定；Credit account/grants/hold/allocation/journal；usage settlement、admission/outbox/result | 终态短路前先验证identity/digest；默认UUID成功与重放是必验，不用短ID代替 |
| expiry | batch receipt；按账户排序再重查eligible holds；Credit投影/allocations/outbox与精确expired IDs结果 | Redis仅协调；一次命令预算内处理有界batch，重放不扫描新对象 |
| settlement/退款效果 | 根settlement/reversal；Credit fulfillment/grant/journal/reversal；audit/outbox/result | HTTP是否只接受事实、何时执行Credit由B8-D2冻结，禁止临时靠webhook补效果 |
| provider event | 独立claim后锁inbox并验证attempt token；owner业务组与inbox terminal一起提交 | attempt/error在独立生命周期，见下节；business回滚不吞掉失败记录 |
| execution event | 独立claim后锁execution inbox、admission与Credit组；terminal同提交 | unknown执行结果保持hold，禁止盲扣/盲释放；lease/retry单独事务 |
| reconciliation | READ ONLY REPEATABLE READ，所有owner查询加入同一快照 | 检测结果不是自动调账；受控修复另起owner命令，携带观测版本并重新验证 |

原子组以测试中的backend/txid、提交前外连接不可见及深层故障全回滚证明。迁移必须按以上共享Credit事务组整体替换；
中间构建commit不是发布候选，最后删除旧application/domain/infrastructure/interfaces机械层、重复port/factory与pg业务查询。

### Inbox、outbox失败及fencing

Payment的唯一队列/lease authority仍是payment outbox，不再给provider inbox增加第二套lease。ProviderInboxRepository拥有其状态写入；
独立`beginAttempt`事务验证当前outbox scope+ID+token+未过期且非终态，再给对应inbox写入新的processing_token并增加attempt，提交后才执行业务。
业务事务先锁inbox并核对token/非终态；最终inbox success/ignored与业务effects一起提交。失败后另起独立事务，只有相同inbox token且非成功终态才写安全错误码；
较新beginAttempt或并发成功使旧失败更新0行，视作stale而不是重试覆盖。beginAttempt始终按outbox→inbox顺序锁定；business不反向锁outbox。
账务事务持inbox锁时其他attempt等待受预算约束，不能无界卡住claim；outbox handler在成功提交后才ack。

Outbox claim/renew/ack/retry/dead-letter由独立生命周期调用Prisma root client，明确不继承调用方失败ALS上下文；仍复用同一个PrismaClient/adapter pool，
不是创建第二套pg连接栈。lease有效性比较数据库实际时钟`clock_timestamp()`，不是长事务开始时间；过期token不续租/ack/retry。
持久payload decode纳入handler同一try/finally与attempt预算，合法JSONB数组等poison最终死信，handler零调用；不得把parser放宽为任意JSON。
续租停止时await在途renew，防ack后后台写入；claim attempt>=max不再执行有副作用handler，先用具名owner只读幂等结果查询恢复。
最后一次业务已提交但ack前崩溃时，已成功结果应fenced ack而不是直接死信；确认未执行/失败才进入死信，结果未知保留显式待核查，不盲重放effect。

Execution没有独立outbox队列，其inbox自己维护lease_token/lease_until、attempts/next_attempt_at与terminal/error；Metering ExecutionInboxRepository为唯一状态writer。
claim用SKIP LOCKED，业务事务锁行验证token，success与Credit effects同提交；回滚后fenced失败写，有限重试与死信/人工检查，不能多个worker顺序SELECT同一received行。
失败记账自身失败必须有安全结构化日志/指标，并由可重领的过期lease恢复，不能输出处理成功。未配置事件接收者不得把outbox标published来清空积压。

### Prisma raw SQL窄清单

普通CRUD、聚合和投影用typed Prisma；所有raw都用当前Prisma事务、固定结构、绑定值及显式结果边界校验。
允许用途限：事务set_config预算/UTC/search_path；按固定业务namespace的advisory锁；具名行锁；队列SKIP LOCKED claim；真实时钟fence；
reconciliation只读快照设置。每个实现切片列出实际文件/SQL/返回schema/反例，再授权，不允许把原pg SQL整体塞入raw wrapper。
identity partial UNIQUE用已有生成能力+事务互斥和完整重试维护；不删约束、不新增通用unsafe API。

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

尚待B8真实业务切换：单一Credit/Ledger writer、跨模块同事务context、完整目标表/全部业务用例覆盖、deadlock/serialization恢复、
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


### B7b 冻结方案修正（2026-09-10记录9月8日裁决）

TypeScript6.0.3 + typescript-eslint8.69.0 + ESLint10.10.0为本切片实际冻结版本；原8.70候选在安装当时未过pnpm默认发布冷却期，
不加豁免、不改变规则强度，采用相同peer且成熟的8.69。完整命令和版本证据见IMPLEMENTATION_PLAN的B7b执行中裁决。
JSON边界仅收紧非标量quote credit、非string provider reference与缺省parsed结果时的非法webhook ID/type，复用既有错误体系；
installer新增单元异常注入，保证falsey主异常不被资源关闭异常覆盖。文件归属/范围按任务板新增授权，不扩展生产owner/SQL/API。

历史P0（S4已修复，证据见任务板）：默认UUID hold加hold:前缀曾生成41字符usage ID，超过canonical VARCHAR(36)。当前独立事件UUID与持久hold绑定已替代拼接；内部key/source使用admission UUID，255字符外部invocation保持原样。
B8的ID/事务设计必须闭环此问题；B7b短opaque ID fixture只隔离receipt类型校验，明确不代表默认生产capture路径可用。


### B7c 工程依赖图门（2026-09-10）

采用既有test/architecture内的图类型、AST/resolver核心、真实project读取器、Billing策略、virtual反例测试五文件；与scripts或production相比，
这是测试门而非业务运行能力，不增加CLI或生产依赖。精确文件/行为/验证范围见唯一任务板B7c卡。
当前旧application/domain方向由AST全值/类型边验证；目标modules跨feature通过显式<feature>.public.ts，不强制四层或ports。
当前HTTP仅runWithBillingContext的具名导入和七组精确type-only循环是明确B8过渡债，不允许增加symbol/边或目录级豁免；
B8必须消除并删除例外，当前不宣称所有类型依赖无环或Credit writer已唯一。value循环、未解析/动态加载和越界必须失败。
SQL/tenant/权限/契约/生成门不因旧目录形状门退出而放宽；三设计面无业务变更，此门只放行工程测试改动。

执行中追加批准typescript-dependency-project.ts承载真实tsconfig/文件扫描I/O，图引擎保留纯分析与可替换host；共七个改动文件，
无新依赖。扫描.ts/.mts/.cts/.tsx，只有精确src/generated/prisma生成目录可跳过；已解析但未入图的本地依赖显式失败，
不把外部wrapper自动当安全外包。静态template及import options纳入语法正反例，database/cache与角色边界覆盖相同源扩展。
当前冻结交付待Root验收，不将writer无基础设施测试结果当整仓验收。


### B7d 格式治理（待B7c验收后实施）

采用仓内精确Prettier3.9.6与仓根空配置，正向覆盖手写源码/测试/脚本和工程配置，format:check进入verify。
仅格式化，不改变业务架构或数据/API事实；SQL、OpenAPI、只读Prisma产物和lock由各自authority治理。
文件放置、精确排除及可执行正反例见唯一任务板B7d卡；纯格式文件须逐一匹配固定formatter对基线源码的输出，
并在当前冻结树重新通过全门。此设计不授权在B7c验收前格式化其变化中代码。

## B8-S0 Stripe一次性付款准入局部设计（2026-09-10）

这是当前实现上已复现的支付状态错误的局部修复，不搬模块、不改表、不引入Prisma生产writer，也不绕过B8-D2整体重写门。
Owner为Billing Payment的Stripe事件归一化；只修改既有stripe-webhook-provider.ts中的一次性付款分支，复用官方SDK验签与当前inbox/processor事务。
仅checkout.session.completed或checkout.session.async_payment_succeeded且object.mode严格为payment、payment_status严格为paid、subscription缺省或NULL，
才归一化为payment_succeeded。mode/payment_status缺失、不支持或非paid，以及任何非NULL subscription引用均不得进入一次性Credit发放。
未满足条件的合法事件保持原event type、空order/payment/refund/订阅效果字段，由现有processor ignored并ack该事件；不取消Checkout、不关闭未来async成功事件。
当前SQL报价amount_minor>0、当前Checkout创建不配置免费/折扣发放；no_payment_required不在本切片paid-only发放profile内，不能当作已付金额。
订阅权益、免费试用/折扣政策和现代周期处理仍归B8-D2/provider完整方案，不伪装成本次已修复。

局部放置：生产原文件保持现有owner；新test/unit/stripe-payment-gating.test.ts专测分支矩阵，新test/integration/stripe-payment-gating.test.ts专测付款准入→真实账本，
优于继续向混合provider-registry或mock-checkout-payment测试堆场景；复用既有test目录，不建新目录。provider-registry.test.ts只修合法paid fixture及加强成功eventType断言。
验证先RED再GREEN；真实runtime HTTP+官方SDK测试签名+PG inbox/outbox/processor证明unpaid不产生settlement/account/grant/journal，后续paid async一次发放、同event重复和迟到unpaid不重复发放。
失败签名不落inbox；外部Stripe API不得调用，不能称Stripe sandbox。Root用独占PG全门/Prisma/schema/源码dist smoke验收，canonical SQL/OpenAPI保持原字节。


## B8-D2a Checkout持久恢复（内部设计已审查；不授权当前v1/DDL切换）

### 当前事实与方案

8b55a57仅修正S0付款准入。当前application CheckoutService以withTransaction包createHostedSession，pg类在FOR UPDATE后调用Stripe；
12秒Promise.race不等于取消，尚未收到session ID的超时没有持久恢复身份。HTTP报价expiresAt为5分钟，Stripe创建请求没有expires_at，
两者语义不同。目标不把5分钟值发送给Stripe：其可指定会话过期时间为创建后30分钟至24小时；默认24小时。

比较继续长事务（占用连接/锁且回滚不能撤销provider副作用）、仅把await移出事务（崩溃/重试参数/重复创建仍不闭合）、
持久claim→事务外调用→条件finalize（采用）。扩展既有billing_checkout事实，不另建通用支付任务表/新业务模块/新队列。
本节只确定内部状态和实现边界，新增HTTP结果/查询与major、全量SQL及数据演进仍由B8-D2其余门处理。

### Owner、依赖与文件职责

Checkout唯一写checkout/session过程。Payment拥有provider account事实与可信账户解析；Credit仍唯一写账本。
因此对B8-D1作一个具名DAG修正：CheckoutModule只读导入Payment核心公开PaymentAccountReader，不导入PaymentEventsModule。
prepare时在同一短事务内requireActiveCheckoutAccount(tenantId, providerAccountId)，返回所属tenant、provider、外部账户与provider_environment（test/live）的只读投影；
凭据来自config中的受控绑定，不来自请求体或metadata。目标Payment账户补test/live环境事实（见DATA_MODEL）；现有配置尚未验证这些条件，不能假造已验证值。
Payment核心不反向依赖Checkout；PaymentEvents子模块继续导入二者，Subscription/Refund只通过核心公开面，无forwardRef或全局provider。
每次claim查询账户启用状态并校验配置身份；已停用/指向别的账户时拒绝该claim的网络调用，未知会话转review_required。
claim获准后与并发停用仍有竞态，不能承诺停用撤销已发请求；结果继续核验和留账，历史到账mapping保留与验签规则由Payment接收链另验。
目标Checkout prepare要求有效provider账户配置；catalog查询可在未启用支付时工作，但不再把没有provider的Checkout当可付款会话。该收窄属于待决major API门。

未来切片的具名位置（只在相应实施卡批准后创建）：src/modules/checkout/checkout-session.service.ts承接状态机/短事务编排；
checkout-session.repository.ts承接typed Prisma查询与fenced更新；checkout-session.schema.ts承接版本化内部请求快照/结果解析；
stripe-checkout.client.ts只封装官方SDK边界与provider响应校验；checkout.module.ts显式装配。已有Catalog组件保持同feature，
不创建services/repositories/ports子目录或BaseRepository。相比放进src/database，网络会话是Checkout业务职责；相比全局providers，当前只服务Checkout。
跨模块公开能力只使用内部业务对象，不暴露Prisma/Stripe类型。运行时恢复tick装配进既有payment worker进程，不创建第四个常驻业务进程；
tick只调用Checkout公开恢复能力，支付事件与session恢复各有有限批次/并发预算，不能让一个队列长期饿死另一个。

### 不可变请求与两个生命周期

首次prepare接受quote时生成checkout UUID，验证tenant/subject、offer revision、金额/币种、credit/周期、配置账户，
以现有tenant/key+versioned digest判冲突并持久化quote事实。查到既有Checkout时先核caller业务输入digest并返回其当前结果，
不因当前报价/配置变化重新prepare或换资源ID；只有首次接受才校验新quote/配置。后续每次claim仍检查账户/凭据身份。锁后不得读取新报价替换已接受snapshot。
会话请求快照固定：provider/account/provider_environment/API版本、checkout_session_mode、checkout/tenant/subject身份、报价/line items、所有metadata与success/cancel URL、
创建策略版本。API key/token不入snapshot。记录canonical digest，重放逐字义相同参数；配置URL/API版本/商品名称变化不能改旧请求。
Stripe idempotency key固定为billing-checkout:<checkout UUID>:session:v1，与attempt token、HTTP request ID和worker身份无关；同checkout永不另换key重建。
provider_environment只表示test/live；checkout_session_mode由固定报价billing_interval决定（once→payment，month/year→subscription），两者分字段/独立校验。
本仓没有setup业务，因此不创建setup会话；S0的payment-only付款发放规则不应误裁剪本恢复设计所承接的订阅会话创建。
凭据可轮换但必须仍对应同provider账户与provider_environment；旧API版本不可用/账户身份漂移走review_required，不静默重新渲染请求。

quote_expires_at只控制首次prepare准入。prepare成功后即接受固定报价，恢复不重新判断当前offer启用/报价截止；
provider_session_expires_at是Stripe实际返回的支付会话截止，未获响应时为NULL，绝不把quote截止冒充会话失效。
本profile继续不发送expires_at而采用Stripe默认会话TTL，完整请求固定；这避免重试时为满足相对时间限制而改参数。
该策略是项目选择，不宣称5分钟的现有wire expires_at已具有新含义，API变更需major门。
Checkout业务status与session_creation_status正交：前者记录付款生命周期，后者记录一次外部创建命令，不能用一个pending布尔同时代表二者。
session_creation_status限定not_started / in_flight / unknown / ready / failed / review_required；next_attempt_at只控制unknown重试时机。
ready表示provider session身份已持久确认，不等于已支付、不保证URL永久可用；只有provider状态open、非空URL且实际截止未过时才向受信付款者返回URL。
complete+unpaid仍等待异步付款，expired不生成新session。付款仍需Payment验证后的事实与Credit事务效果；迟到已付证据可将本地expired/cancelled纠正为paid并留审计，不因旧本地终态吞掉真实付款。

### Claim → 网络 → finalize

1. prepare短事务写完整immutable snapshot、stable provider key与not_started，或返回同key的同一Checkout。外部网络零调用。
2. claim短事务锁Checkout行；not_started或到期unknown可领取，未过期in_flight返回pending。新UUID attempt_token、attempts+1、
   lease_until/first_attempt_at及retry_deadline_at在调用前提交；时钟用数据库clock_timestamp。commit未确认时不得发provider请求。
3. 无active/closed ALS事务上下文地调用provider；明确assertNoActiveTransaction，不通过清空上下文绕开调用方仍持锁的错误。
   输入只来自已提交snapshot，调用者不拿Prisma client/行锁过网络等待。worker重启扫描同一持久行，Redis不作领取authority。
4. finalize新短事务比较tenant+checkout+attempt_token+in_flight及lease有效；分别校验provider/account/provider_environment/checkout_session_mode/session关联、金额/币种与snapshot一致，
   然后写session ID/URL/实际过期时间并ready。付款业务status不从paid/expired/cancelled回退到pending_payment。
   已知ID但响应缺URL（已完成/过期）仍保存ID及provider状态，不把它当创建失败再POST；amount/身份不符保留安全错误并review_required，零Credit效果。
5. 超时/断连/5xx/响应不能验证为成功或确定未执行：在新事务按同fence写unknown、next_attempt_at/安全错误与provider request ID。
   不猜测失败，不生成新Checkout/key，不用failed receipt永久吃掉可恢复命令。确定输入/配置失败且无先前未知尝试才可failed。
   session_had_unknown是持久单调历史事实，不能从当前status或attempts猜测；unknown记账、过期in_flight被接管时均在短事务置true且永不清零。
   同一SDK调用内部若先断连/超时再重试，transport记录attempt-local uncertainty；finalize同时合并此标志与持久flag，即使最终4xx也不得failed。
   进程在标记前崩溃由过期in_flight接管保守置true；旧token无权标记新attempt，但接管事务已先保留其未知可能。
6. 旧attempt的成功/错误都不能覆盖新token或已ready/paid。fenced写零行时重新只读当前状态；不把零行更新作为本attempt成功。
   本地迟到结果不能越过fence直接落库；后续由当前claim按同key恢复，或Payment可信事件的独立owner能力确认结果。

create结果提交确认丢失时，只读查本Checkout持久状态；未知DB commit不重跑provider或扣款。任何provider步骤均不属于可自动重试的Prisma业务事务。
claim/token持久化与首次sent意图之间的崩溃按unknown恢复：即使实际上未发送，也保守使用同一key/snapshot；不能证明没发送就不重置first_attempt_at。
lease过期只能授予下一attempt的写入权，不能证明前一个请求已撤销。新的provider请求仍用相同key，Stripe冲突/限流按错误分类处理。

### 恢复范围、预算与停止条件

恢复只扫描本owner not_started和到期unknown/过期in_flight，使用FOR UPDATE SKIP LOCKED和确定排序；每批最多20、并发2为待实测目标。
扫描与claim同一短事务，SKIP LOCKED不保证公平，next_attempt_at+id排序和SLO必须测久等；query/index见DATA_MODEL。
create目标每attempt总体12秒、单I/O最多10秒、connect至多3秒、lease30秒；create恢复最多12次且首次attempt后60分钟截止，
并额外限制在Stripe幂等安全窗口内（first_attempt_at+23小时保守界限）；未知结果不能因进程重启刷新这些预算。
退避目标1秒起、指数上限300秒、jitter；下一attempt在elapsed/次数/lease边界内才可领取，不为准时重试放宽幂等窗口。
达到次数/时间上限后先查本地已确认结果，ready则结束；否则review_required，禁止换key、重新POST或把列表空结果当不存在证明。
provider返回5xx包括cached500时仍unknown；缓存的失败可一直重放，不承诺retry最终总能恢复成功。409/idempotency参数冲突区分“正在处理”与“参数漂移”；后者必须review。
如果session_had_unknown或本SDK调用内uncertainty为true，即使随后4xx也不能证明从未创建，应保留review而非确定failed；同key修参数不是允许路径。
failed仅允许没有上述不确定性且能确认未执行的错误：本地发送前校验/配置失败，或实施时有官方语义及真实回归证明的具名provider错误；
不能按全部4xx推断未执行，也不能从错误文本或tries=1猜测SDK从未重试。
已知session ID用官方retrieve只读核验；未知ID不伪造按metadata查询。官方list没有client_reference_id/metadata过滤，分页找到候选仅作正向核对，未找到不足以断言不存在。
人工处理只能通过未来具名owner命令绑定经过校验的已有session/确认provider终态，携带actor/reason/audit；本轮不增加空admin接口或直接SQL修账。
review_required不会自动取消checkout、删除账务或阻挡后来真实付款证据；迟到已付金额仍进入可审计Payment/Credit流程。

### 真正的取消与关闭

目标使用官方Stripe SDK + 官方可注入FetchHttpClient，将本attempt AbortSignal与SDK传入signal组合交给Undici官方fetch；不重写Stripe签名/HTTP协议。
具体传输选择：官方undici 8.10.2作为候选直接依赖，通过进程拥有的有界Agent/dispatcher配置connect timeout，
而不是把FetchHttpClient整体timeout冒充connect阶段。每请求显式传dispatcher，不调用setGlobalDispatcher；fetch与Request/Response/Headers类型保持同一Undici实现。
同进程Stripe网络共享这个受控dispatcher，attempt只持自己的signal/轻量SDK实例；连接池与请求并发都有上限（初始并发2），不每attempt建新Agent。
关闭顺序是停claim→abort/await各SDK任务→await自有dispatcher.close→Prisma关闭；close超预算只能destroy本进程自有dispatcher并非零退出，禁止影响其他模块/进程的全局dispatcher。
官方connect timeout配置须以DNS/TCP/TLS stall及已建连后慢headers/body分离测试证明，连接后慢响应不得被错误计入connect失败。
配置maxNetworkRetries=0以让durable恢复拥有主要重试预算，但SDK对部分closed-connection仍可能自身重试，必须验证实际次数和退出时限；
不把0当“底层绝无重试”的保证。attempt-scoped SDK/transport可持有该signal，不能将一个attempt的abort污染其他请求；不建无界client/Agent池。
总deadline和shutdown会abort该请求并await SDK任务及清理终态；单纯Promise.race返回后留下背景副作用不算实现。
本地abort最多证明不再等待/发送本地数据，不证明Stripe未执行，所以结果仍为unknown。恢复worker先停领取、取消/等待自身任务，
再关闭Prisma/进程资源，bounded drain失败显式非零退出并让lease恢复；不强制清他人数据库/共享Redis。
供应链预核2026-09-10：npm view undici version/dist-tags/engines/license显示稳定8.10.2、Node>=22.19.0、MIT，最新修改9月4日；兼容本仓Node24但尚未安装/锁定/审计。
比较保留自定义HttpsAgent并另写取消层、只用global fetch而缺独立connect控制、官方Undici Agent+SDK FetchHttpClient，采用第三项减少自造网络逻辑。
Undici由Node.js组织维护；性能/连接复用/SDK类型和故障语义由实际压测/门禁决定，未宣称更快。失败退出是不发布中间切片，保留上一个已验commit而非运行双transport fallback。
安装前再核精确版本、冷却期、Node/Stripe类型兼容和audit，并在同切片完成TLS/body/abort/drain验证；本候选不是安装放行证据。
具体官方FetchHttpClient接口、AbortSignal合成及SDK retry-drain行为在安装/实现时实测后才放行；这是待验目标，不凭名称宣称已具备取消能力。

### Payment观察与账务安全

PaymentEvents完成raw-body验签、账户/tenant映射后，可调用Checkout的transaction-bound确认能力；
它基于可信session ID、checkout关联、provider/account/provider_environment/checkout_session_mode/金额/币种与已存snapshot分别核验，不需要当前create attempt token，也不从浏览器success URL推断已付。
只接受一致身份或首次NULL→可信session ID绑定；不同ID/账户/报价冲突转可审计异常，不覆盖既有绑定。只填会话事实，不自行发Credit。
该独立证据可在创建响应前到达并确认session；旧create finalize随后只能读取结果，不能退回付款status。
S0只是付款状态门；完整provider事件仍需明确金额/币种/session匹配、invoice/订阅/部分退款的稳定identity，不能把本设计当这些已全部实现。

### 实施验收矩阵

- 真实PG两个独立worker同Checkout并发只一有效claim，外连接在provider故意阻塞时可读已提交claim并更新无关Checkout；
  provider入口断言不存在active transaction，不能只mock withTransaction调用次数。
- 故障点覆盖prepare前/后commit、claim commit确认丢失、发送前、响应丢失、provider已创建后进程退出、finalize commit确认丢失；
  重启沿原key/snapshot恢复，不新增会话或Credit；实际本地SDK HTTP故障server与真实PG联测，Stripe sandbox另验。
- 同key同内容并发/replay、不同digest冲突、账户/subject/tenant漂移、配置/API版本/URL变更不改旧请求；quote截止与会话截止分别测试。
- 超时必须abort并完成自身任务清理；late success/error、旧lease、deactivated account、cached500、409、429、错误响应、缺URL和错误金额分别断言。
- unknown→claim→4xx、进程重启/过期in_flight接管、SDK内部先断连再4xx均保留session_had_unknown并进入review；旧token不能清零或覆盖，新旧环境/会话mode交叉错配拒绝。
- first_attempt_at/deadline/attempts跨重启不刷新；超次数/60分钟/23小时边界停止POST，known session只GET，unknown转review；零结果不伪装不存在。
- verified webhook先于create响应、重复/乱序/迟到付款、已paid不回退，session identity冲突零额外账务；S0所有原回归保留。
- shutdown拒新任务、abort/drain/Prisma关闭顺序、Redis丢失、owner query与worker DAG；目标Schema fresh/catalog/Prisma、全unit/integration/contract/build/smoke。

官方语义核验2026-09-10（官方工具语义而非本仓实现证据）：
[幂等](https://docs.stripe.com/api/idempotent_requests)、[错误与unknown](https://docs.stripe.com/error-low-level)、
[创建会话/过期](https://docs.stripe.com/api/checkout/sessions/create)、[已知ID查询](https://docs.stripe.com/api/checkout/sessions/retrieve)、
[列表能力](https://docs.stripe.com/api/checkout/sessions/list)、
[Undici连接预算](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)、[Agent生命周期](https://github.com/nodejs/undici/blob/main/docs/docs/api/Agent.md)。SDK22.6.1本地请求/取消证据另记任务板。

## B8-D2c Refund身份与Credit冲正（内部设计R2已审查，生产/major未放行）

基线c160bfe。D2b证明三HTTP入口仅record事实、Recorded未被现有worker消费；下文是替代目标，不描述已上线功能。
沿用七模块DAG：Refund调用Payment核心锁定付款快照和Credit公开冲正能力；PaymentEvents只做渠道事件编排，不再查询/写入Credit表。
Refund业务文件放既有目标`src/modules/refund/`下具名service/repository/schema；Credit分配与写账放`src/modules/credit/`。
对比把反向账务放PaymentEvents、Refund自写Credit、Refund编排Credit三种方案，采用第三种以保持唯一writer；不新增通用Saga/退款任务模块。

### 三个操作分开，既有业务范围不偷换

1. 渠道观察：接收已验证的退款对象，保存身份/金额/币种/状态及来源证据；不意味着本服务调用过退款API。
2. 发起外部退款：是独立的商户命令，涉及权限、可退款额度预占、稳定provider key、短事务claim/事务外调用/unknown恢复。当前没有该实现；不能把accept入口或admin审计改名就称支持。完整发起策略及机器major在后续门交付，本节不删除该待办。
3. Credit冲正：仅处理已确认的退款与已绑定的履约快照，使用本仓现有单一grant比例退款规则；不把渠道minor units直接当micros，不从caller传来的任意amountMicros推导合法性。

当前单grant比例规则是已有reverseCredits行为的承接，不外推到多行价格、税费、订阅期、赠送积分或额外收费。
当前line_specific只拼reason，尚无行模型/行选择器/执行算法；进入新major时应形成真正可校验的行分配契约或明确拒绝，不能继续接受后伪称已执行。
该商业面、欠额恢复与退款失败后的补偿政策仍待独立决定；本轮不凭空建立负余额、自动补发、释放用户hold或自动再次退款。

### 渠道退款身份与可信关联

内部RefundObservation保存providerAccountId（含固定provider/environment）、externalRefundRef、externalChargeRef与externalPaymentIntentRef、amountMinor、currencyCode、providerStatus及sourceEventId。
Refund业务去重为账户scope+Refund.id；Event.id只用于inbox投递去重。同一Refund的不同事件可以改变观察状态，不能生成第二笔退款。
金额/币种/付款绑定一旦接受后不可按新事件覆盖；冲突保留durable inbox证据并进入review，不用不同event key避重。

Stripe使用已验签Refund对象的id/amount/currency/status与charge/payment_intent关联；展开对象仅取经schema校验的id。
Stripe amount必须先验证typeof number、Number.isSafeInteger且>0及适用provider金额上限，再转BigInt/十进制字符串；拒绝fraction、NaN/Infinity、unsafe integer、string/object/null，禁止先Number(string)或共享major-decimal转换。JSON已舍入的2^53+1无法通过转换恢复；未来provider decimal-string输入须独立digits schema直接BigInt。
校验执行账户/test-live、对象类型、非空身份、正整金额、币种与确切付款映射。二者同时有值时必须指向同一settlement；不使用Checkout下最新付款或metadata自报tenant猜关联。
Settlement必须保存经验证的provider charge/PaymentIntent引用（字段见DATA_MODEL）；尚缺映射时是待关联/复核，不取最新settlement代替。
charge.refunded只是Charge变化信号；其amount_refunded是累计值，refunds.data[0]不代表完整退款集合或本次事件唯一退款。
禁止charge.id、Event.id、常量unknown充当Refund.id，禁止缺amount回退整单金额。退款对象缺失/未知状态保留待复核，不转换成功。

订阅退款仍可记录渠道事实，但其Credit映射必须由Subscription有效付款/period契约提供，不对它直接套一次性grant算法。
退款状态pending/requires_action没有成功扣积分资格。succeeded只表示当前渠道观察；后续failed/canceled或矛盾终态必须保留新证据并进入review，不能把succeeded写成永不接受新事实的吸收态。
Event.created不提供同一资源严格版本；迟到pending不倒退已确认结果，矛盾终态须重新查询确切Refund对象或人工核对。查询在事务外且有预算/账户校验；查询返回再经同一观察能力落库，不在锁内访问Stripe。
已冲正后遇到渠道失败保留原journal/fulfillment reversal与applied状态，另设review标记，不删除原账、负负得正补发或重新占用退款额度；补偿另走明确受审计的Credit命令。

### 两个持久阶段，账务效果仍为一个原子事务

**T1明确两种入口，不混用root与effect**：
- ProviderEvents root已完成验签、执行账户/tenant映射与D1 beginAttempt，在其现有最外层事务调用transaction-required的`Refund.observeProviderRefundEffect`。Refund加入当前事务，不能另claim Refund command receipt或自主commit。锁确切settlement并验证Refund identity/金额/币种/绑定；只有可信且规范化succeeded观察有资格把waiting_provider转pending（映射齐全、无review）并enqueue唯一RefundCreditEffectRequested(v1)。Refund观察、inbox processed终态及effect outbox同提交；异常沿D1整组rollback-only，不在失效tx补成功receipt。
- HTTP/内部`Refund.recordRefund`是独立root command，claim/replay本命令receipt，只保存契约允许的record事实。受信调用者身份不等于渠道已成功证据：无可信provider观察时status=unknown、credit_effect_status=waiting_provider且不enqueue T2；body自报succeeded不提升为渠道验证。已有provider事实先到时record命令只校验/重放自身结果，不降级或重建效果。新观察API/商户create的证据与权限由major另定，不暗改现v1。
- command先到再provider成功、provider先到再command、二者并发均汇合账户scope+Refund.id；交易内校验财务绑定冲突并保留review，只有一个Credit effect outbox。等待渠道的record不会永远假称processing Credit，查询明确waiting_provider。
来自已验签渠道的退款若暂时缺settlement/映射或出现累计矛盾，其原事件已在durable inbox，标待复核/受控重试而不丢证据、不猜账。
退款事实与Credit效果不再强行处于同一个外层事务：Credit余额不足或进程崩溃不能把已确认渠道事实抹掉。这是对B8-D1粗表中refund整组事务的明确细化；receipt成功仅对应record这个命令。

**T2账务应用**：唯一payment worker按outbox lease调Refund.applyCreditEffect → B8-D1最外层事务 → 锁settlement/reversal → Credit锁account、grant、相关allocation（确定顺序）→ 计算/验证delta → journal+grant+account+fulfillment reversal+Refund的credit效果状态+Credit outbox同提交。
T2没有provider网络；Credit业务预检返回applied/review_required具名结果，先验证后写账。SQL/解析/不变量异常标rollback-only整组回滚，不能catch后用同一个失效tx写review。
业务不足/映射歧义可以在零Credit写入下提交Refund review状态和审计；非业务异常的最终dead-letter/诊断沿D1独立fenced失败写入，refund查询必须同时反映队列故障，不能永远显示普通pending。

`RefundCreditEffectRequested(v1)`是本仓内部执行事件，payload只有tenant/refund identity及schemaVersion，策略/财务输入从已绑定持久快照读取；以refund identity去重，不把原Recorded两类全部接到任意handler。
已有payment worker进程加入该明确handler，公平有界处理provider事件与Refund效果，指标按事件类型区分积压/死信；不加第四个进程。
应用已提交但ack丢失时重放读取既有结果并ack，不第二次冲正；outbox达到attempt预算同样先确认既有成功结果。超时/lease丢失的handler不得覆盖新token结果。
Refund业务和Credit事务使用账户/业务锁防重复，outbox lease不是账务唯一性来源。review结果不无限重试；具名owner重试须受审计且使用同一Refund身份，不new key开新账。

### 承接比例算法并修正离散单位边界

限定同一settlement对应一个确定的Credit fulfillment/grant；G=该grant原始micros、S=对应付款minor，二者来自不可变履约/付款快照。
R=已成功应用Credit效果的退款minor累计（含零delta结果），C=这些效果的micros累计，a=本次已确认退款minor。
在settlement锁内计算：`target = ceil(G * (R + a) / S)`，`delta = target - C`；全程BigInt，结果落库/wire使用十进制字符串与受测范围映射。
约束G>0、S>0、0<a、R+a<=S、0<=delta<=G-C；冲正已存在先校验固定输入摘要/绑定再重放，不能像旧实现一样忽略改account/amount的重放参数。
zero delta是合法离散结果：例如G=1、S=3、连续退款1/1/1，delta为1/0/0，最后累计恰为1；旧delta<=0抛错会卡住后两笔。
因此每笔退款都保存applied结果及参与累计的minor；delta=0仍保存fulfillment reversal与策略/计算结果，但不写零值journal、不修改account generation/grant，不把它当失败或丢掉累计R。
同一settlement不同refund的处理顺序可以不同，最终累计一致；每笔实际delta与计算前R/C持久可审计，已提交结果不会因后续事件重新分配。
累计只使用已applied效果，不能按渠道当前status过滤历史已扣账行，否则succeeded→failed会把已扣金额从基数中抹掉。未解决渠道矛盾对该settlement暂停新增自动Credit应用，交review。

仅delta>0才要求grant处于可扣状态，且目标grant扣除未捕获未释放hold占用后的freeMicros>=delta、account.available>=delta；不能只看全账户余额与grant.remaining。
其他grant的可用余额不能掩盖目标grant已占用；不动held、hold/allocation承诺或借用其他grant来“退款成功”。正delta的已消耗或不足交review，不做负余额。
delta=0仍校验tenant/identity/付款和履约绑定/固定G/S/policy/累计额度及无未解决渠道矛盾；本退款链先前冲正造成的exhausted不阻止applied零结果，不要求余额、journal或generation变化。过期/撤销grant即使delta=0仍保守review，不能自动恢复权益；不把有未知原因的exhausted当已验证退款链。
所有Credit mutation均先锁account再grant/allocations，journal sequence在account锁内分配；删除旧Refund先锁grant、先读MAX序号后锁account的实现。

### 验证与本轮尚未交付项

实施须实跑真实PG：两连接同Refund与不同partial、不同事件同Refund、支付/退款乱序、丢ack与重启、inbox/T1/T2逐点故障、zero delta、G/S极值、已用/已held且其他grant有余额、状态失败回流、输入漂移、跨tenant/账户/币种/charge冲突。
额外覆盖command→provider、provider→command及两者并发的唯一effect outbox和inbox原子终态，安全整数上界/越界/JSON舍入反例，以及首笔后grant exhausted仍完成后两笔zero delta、expired/revoked零效果review。
合同测试需分别覆盖record结果与当前查询结果，退款创建则另覆盖SDK超时/unknown/稳定key和provider sandbox。原名为concurrent-safe的比例测试当前顺序调用，不构成并发证据。
尚未交付canonical字段/约束、Nest/Prisma实现、精确新major HTTP/API query、外部退款创建、行分配/订阅退款政策、补偿流程；完整B8设计/部署门仍未通过。

官方语义核验2026-09-10：[Refund对象](https://docs.stripe.com/api/refunds/object)、[Event类型](https://docs.stripe.com/api/events/types)、[退款失败](https://docs.stripe.com/refunds#failed-refunds)。
官方说明渠道对象与异步失败语义；两阶段事务、唯一writer、比例算法承接和review策略是本仓设计选择，不称Stripe推荐账本架构。

## B8-D2d Subscription身份、账单证据与Credit发放（机制R2已审查；商业发放规则待确认）

基线9bab7da，生产仍Fastify/pg。当前creator只输出checkoutId/tenantId/subjectId，旧parser却要求teamId/planId；旧processor依metadata选择最新published offer并覆盖subject，active/trialing直接发放。
本节修正结构性设计，不把尚未确认的试用/零元/手工结清商业规则写成已批准功能。用户已获询问“是否账单结清后发放”；未答复前仅冻结身份/证据/事务机制。

### Owner与放置

Subscription拥有provider subscription、period、term；Credit拥有fulfillment/grant/journal（R2合并授权），Payment拥有provider account/inbox与真实支付settlement。
PaymentEvents作为上层编排调用Subscription transaction-required观察能力，不直接查offer/Credit或写三张订阅表。Subscription仅经Checkout取得固定报价与绑定，经Payment核账户，经Credit执行具名发放；沿D1无环DAG。
具名subscription.service/repository/schema与invoice归一化适配放目标src/modules/subscription内；Stripe SDK类型不穿透内部业务对象。比较PaymentEvents直接SQL与Subscription编排Credit，采用后者；不为SDK的Invoice对象创建第八业务模块。

### 三种事实与三个身份分离

- Subscription.id：执行账户scope下的渠道订阅生命周期身份；active/trialing/past_due/canceled等描述订阅，不直接决定Credit grant。
- Invoice.id与Invoice line.id：账单及其服务行证据；invoice.paid描述结清，不自动等同一笔新的银行卡实收。实际资金来源/InvoicePayment/PaymentIntent/Charge证据归Payment，不能为零额或手工结清虚构正数settlement。
- 本仓period.id/term.id：周期授权与Credit来源身份；事件delivery ID不是周期身份，当前月份/最新Subscription周期也不是旧账单的授权依据。

本仓现有Checkout只创建quantity=1的单一价格、month/year recurring。首个可自动处理profile承接这个已存在范围：单一已绑定subscription item、一个完整非proration recurring服务行、完整分页证据、固定报价revision及program。
多item/混合周期/补差价/多个服务行/非订阅invoice仍保存inbox并显式review，不任取items[0]/lines[0]、平均周期或给每条行发全额积分；这些扩展需独立商业/数据设计，不假称当前已支持。

### 从Checkout建立可信绑定，报价不漂移

Stripe的checkoutId metadata仅作查找线索：经已验签账户、test/live、session/subscription/customer关联及本仓Checkout快照逐项验证后，绑定本仓tenant、subject、offerRevisionId、program、creditMicros、currency、billingInterval及候选发放policyVersion。
不把provider metadata中的tenant/subject/team/plan当新授权，也不为兼容旧键而长期双读。后续重复事件若改变绑定/报价则review，不UPDATE subject或按latest published revision重解释已付款周期。
provider item/price引用在可信Session/Subscription读取结果与报价价格/数量/interval核验后持久绑定；不要求动态创建的Price ID在首次prepare前已知。补查在事务外、有总预算/取消/账户校验，返回后在短事务条件绑定；配置变更或晚到响应不能替换已有身份。
续期继续绑定原revision快照；真正plan change必须由显式变更命令或经审批的渠道变更同步建立新revision与生效边界，不能把外部price变化当隐式升级授权。

现代Stripe Subscription周期在items.data中的每个item，不把旧顶层字段fallback成当前方案；固定已批准API版本及严格运行时schema。旧版本事件若实际部署仍在投递，处理/排空策略由major与数据切换门决定，不用静默丢弃冒充clean-slate。
Invoice关联按其当前版本parent.subscription_details及line的subscription-item父信息验证；时间窗口用对应服务line.period，不用invoice总体period/current Subscription窗口覆盖历史服务期。
两类引用皆存在时必须一致；账户、subscription、item、price、currency、数量和period逐项核对。分页has_more或字段不完整先有界补查，缺信息不是zero/paid/default now。
时间戳必须安全整数秒、转换后为有效UTC瞬时点且end>start；金额number须safe-integer及各字段允许的正/零/负范围（invoice合计不能照退款正数schema），不共享major-unit转换器。

### 周期去重、证据与商业资格

同一Invoice line的不同Event只更新同一观察；本仓自动profile的周期唯一性同时约束subscription+item+服务start/end+program，避免另开invoice同周期重发。
Invoice/line唯一键防同一账单行绑定到两个period；同周期出现另一个invoice/line视作重开/修订歧义，保留新inbox证据并review，不先覆盖已有绑定或再给grant。
已绑定授权窗口/报价/额度不可变，已applied结果可永久重放；provider状态或新版catalog不会改变历史grant结果。
授权digest只含稳定tenant/subject/account/period/item/服务窗口/program/quote revision/额度/policy，不含会变化的observed_at、Event delivery ID或最新查询时钟；渠道证据使用独立digest，合法新观察不破坏历史授权重放。

发放资格函数返回eligible/waiting_evidence/review_required，并记录使用的policyVersion与证据摘要；不得接收parser的grantCredits布尔值直接执行。
普通成功付费完整周期是拟支持的主路径，但“invoice结清即可”还是“必须特定渠道实收”由用户商业确认。试用赠送、零额/折扣/余额抵扣/低于最小扣款、out-of-band手工结清、宽限期和补差价分别需要明确规则；没有规则则review，不默认为赠送或永久禁止。
policyVersion必须是本仓已批准且随offer revision冻结的具名规则，不是任意JSON flags配置平台；未批准policy不得enqueue发放。当前代码trialing默认发放不是商业已确认的证据。
invoice.payment_failed只是一轮支付失败，不能倒退已经结清的同invoice或移除已发放的旧周期；同样invoice.paid不能掩盖后续退款/争议，后者通过Refund/Payment具名事实处理，不删journal或自动补偿。

### 两个持久阶段与重放

T1由ProviderEvents在其outer事务调用Subscription观察effect：不另claim第二command receipt，绑定/更新Subscription和period证据，处理结果与inbox terminal原子提交；只有完整且已批准policy判eligible才入唯一SubscriptionCreditGrantRequested(v1) payment outbox：T1数据库now<start时period为waiting_period_start、next_attempt_at=start；start<=now<end时为pending、任务立即可领；首次now>=end则review而不发放。
生命周期事件即使active也只更新生命周期，不独立enqueue；invoice先到可以据完整受信关联建立绑定，若关联不齐则waiting_evidence/review且保留inbox，之后具名owner重评同period，不换身份。
事实T1与Credit T2分离，不能因余额/时钟/进程异常抹掉已收到的结清证据。补查网络/分页暂态失败时不把该inbox标processed，沿D1 provider-event有界重试，耗尽进入dead-letter；网络补查在beginAttempt后、T1业务锁前，绝不在事务内。
已完整观察但业务尚未结清的period可waiting_evidence且inbox processed，此时不建Grant任务。新的具名Invoice/InvoicePayment事件可重评；无新事件时由既有payment worker tick调用Subscription.refreshDuePeriodEvidence，扫描period上持久next_evidence_check_at。不是依赖内存setTimeout或尚不存在的消费者。
自动补查仅用于身份已完整且发放policy已批准的period；policy缺失/不支持profile直接review而非网络轮询。首次waiting写next_evidence_check_at及一次性deadline，claim用短事务条件更新到下一检查时刻并递增evidence_check_attempts，然后事务外读取该账户的确切Invoice/必要分页，最后短事务通过period+attempt+claim时的evidence_generation+授权digest检查合并证据、判资格并唯一enqueue。
next_evidence_check_at提前持久化，崩溃可到时再查；每次接受新渠道证据都递增evidence_generation，旧attempt或旧generation返回不覆盖新观察；不依赖Event.created比较新旧。若新的provider事件已使period合格/applied则补查只读已有结果。GET允许重试但不产生外部退款/扣费副作用。候选预算为每批20、并发2、间隔5分钟、每period最多12次/首个等待起1小时，不因重启或失败重置；网络预算沿Checkout受控client方案，落地前以故障测试核值。
预算耗尽置review_required及evidence_refresh_exhausted，清next check并告警；不无限waiting，不删除事实或标invoice付款失败。后续完整可信provider事件仍可重新评估同period；只有等待预算类review可由该证据关闭，身份/政策冲突仍需具名审查。
Reconciliation通过Subscription公开只读快照检查等待超期/死信，再由具名owner命令重试；不直接写period/账本或另造invoice。此机制复用现payment worker进程，不新增第四个进程。

T2由原payment worker明确handler调用Subscription.applyPeriodGrant：period/term锁→Credit account→其他Credit资源锁（D1顺序），一个最外层事务完成Credit fulfillment/grant/journal/account/outbox及period/term效果状态。
Credit只读可信Subscription授权input，不自行SELECT Subscription表或接收任意HTTP amount；Subscription也不取得Credit Repository。预检结果与SQL异常分开，后者整组rollback-only，不吞错后提交“已发放”。
原grant函数在查已成功结果前检查expiresAt>Date.now，会让过期后的同命令重放失败；目标先校验不可变输入digest并重放成功结果，再对首次应用检查数据库时钟和资格。
服务期未开始时不提前增加可用余额，waiting_period_start任务不进入claim且不消耗失败重试预算；到期handler在T2同事务以当前状态/授权digest CAS为pending后执行发放，lease取得或失败本身不把waiting改pending。若T2失败回滚，状态不虚报进行中；首次应用已越period_end则review，是否补偿另有商业规则，不自行把期限延到now+一个月。
成功重放即使当前周期已过期/订阅已取消/报价已下架，也只返回原grant/result，不第二次入账；语义漂移仍冲突。
ack丢失/lease超时/预算耗尽先确认既有Credit结果再ack，显式waiting/review/dead-letter在查询可见；不无限重试或把outbox lease当去重唯一性。

### 对外与实施门

当前GET /v1/billing/me/subscriptions实际把term_id映射为subscriptionId，不是真正provider subscription identity；新major必须显式区分subscription_id、period_id、term_id和grant状态，不原位悄改字段含义。
保留受信subject/tenant分页与查询边界；查询同时展示生命周期、账单证据状态与Credit结果，不能用一个active覆盖所有含义。不会新增Subscription替IAM授权或把UI开通提示当账本事实。
实施验收：creator→现代Subscription→Invoice的真实关联链，paid前后/试用政策/零额政策/手工结清、重复乱序、修改metadata/price/offer、items与lines分页、多item歧义、两连接同周期/同invoice重开、future start/late expiry、已成功过期重放、T1/T2故障与ack丢失。
本轮未改canonical/机器contract/源码。商业资格仍待确认，完整新major/既有数据/外部消费者/退款订阅映射及生产Nest+Prisma实施未放行。

2026-09-10官方语义核验：[SubscriptionItem周期变更](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end)、[Invoice](https://docs.stripe.com/api/invoices/object)、[Invoice Line](https://docs.stripe.com/api/invoice-line-item/object)、[InvoicePayment](https://docs.stripe.com/api/invoice-payment/object)、[事件类型](https://docs.stripe.com/api/events/types)、[站外结清](https://docs.stripe.com/api/invoices/pay)。
以上是字段与渠道语义，不证明本仓已接入；两阶段、period去重及商业policy是项目设计，不冒称Stripe统一规定积分政策。


## B8-D3 数据保护与Reconciliation目标（2026-09-10，内部设计已审查，未实施）

当前仍Fastify/pg；本节补齐完整迁移的内部机制，不应用ACL、不新增现行v1操作。字段/商业资格/真实数据及新major决定仍按B8-D1/D2/B9，不能由本节代替。当前实现差异与Root真实探针见IMPLEMENTATION_PLAN B8-D3。

### 角色、不可变事实与锁

部署能力分为DDL owner/deployer、Billing runtime、reconciliation reader与受控配置维护身份；不是四个业务owner，也不为七feature机械创建七个数据库连接。应用/reader不得拥有表、schema、database，不继承或可SET ROLE至owner，不持SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS/GRANT OPTION/DDL权限。应用无DELETE/TRUNCATE；reader只授予具名检查所需SELECT及schema USAGE。密钥只由部署环境提供，runtime不接收管理连接。

比较三种保护：①继续用对象owner连接（淘汰，owner可重新授权）；②为行锁授一列UPDATE并以不可变trigger拦截（可行但增加canonical函数/触发器与专门ADR、暂不采用）；③在完整事务迁移时把并发保护归入已确定的可变aggregate/receipt与owner事务锁，使不可变事实只需INSERT/SELECT（采用）。**不是直接删旧FOR UPDATE**：现有settlement、journal、acquisition/fulfillment、usage settlement与redeem replay确有行锁；未完成两连接并发/回滚/重放证据之前不施加目标ACL。

- Credit账户/hold/grant等可变aggregate保持既定锁序与条件更新；journal序号和扣款由Credit账户锁/唯一性控制。已存在的永久事实只读重放；首次事实仅在明确ON CONFLICT DO NOTHING的非异常分支后独立语句读取；23505/P2002异常必须整命令rollback/retry，禁止在aborted transaction继续SQL，不把未知状态猜成成功。
- Payment提供tenant+settlement identity作用域的事务锁定快照能力供Refund额度串行使用；可采用受控事务advisory锁，范围/预算/锁序由Payment内部固定，外部不能传任意SQL/锁namespace。Refund继续经Payment公开能力，不直接取得Payment Repository。
- Acquisition/fulfillment/redeem/usage settlement去掉事实行锁必须逐用例证明其receipt、Credit aggregate、source identity UNIQUE覆盖相同并发，不能因名称“immutable”就省略检查。JOIN行锁须显式OF仅锁需更新的aggregate，不让无OF意外锁所有只读事实。
- 应用可变表按列授予UPDATE，不授tenant/主键/命令identity/digest/原始金额/报价正文通用修改权；状态转换仍由owner事务验证。ACL是防误写边界，不是tenant过滤、合法状态机或防篡改账务授权的替代物。

结构唯一源仍database/schema.sql；环境角色/secret/membership由部署provisioning管理，后续显式ACL步骤只引用canonical对象和固定权限清单，不复制CREATE TABLE、不让HTTP/worker启动时DDL。比较把环境角色硬编码进schema.sql与独立部署步骤，采用后者以保持空库安装与Prisma introspection可移植；权限清单另验精确表/列覆盖与实际allow/deny，不用现有catalog零差异冒称ACL已验。新增表/列默认不自动获写权，禁止ALL TABLES/default UPDATE/继承owner兜底。

### 一致只读对账与owner公开面

采用一次性、tenant必填的CLI application context；不恢复旧HTTP reconcile路由，不把扫描塞入支付处理transaction，也不建设第四个常驻业务worker。与只做测试内Service、增加独立网络服务相比，一次性CLI可直接验收、使用独立reader凭据并由部署Job/cron受控周期触发。三个现有业务worker保持职责；CLI是明确新增的一次性运维进程入口，技术依据为本节。周期触发按受控tenant清单逐tenant启动、限制并发/禁止无界全库枚举，不假设Scheduler已有Billing client；最终B10须实跑周期触发与失败告警，手工跑一次不是周期验收。

Reconciliation module只编排六owner导出的reconciliation-read能力，业务SQL留在各owner；配置根仅装配只读能力，不能因导入Checkout/Payment就要求provider密钥、构造网络provider、注册业务消费者或连接Redis。HTTP写入模块复用同一owner读能力，不复制六份查询。公开输入/结果为具名纯业务类型，不暴露Prisma/pg row或任意Record；数据库snapshot上下文内部校验活跃transaction及tenant，由同一个Prisma interactive transaction client承接全部页面，不在各owner另开事务。

| Owner read能力 | 必须覆盖的事实/关系 |
|---|---|
| Credit | account/grant/journal/hold/allocation金额与tenant lineage、无父account的事实、source/sequence唯一性；fulfillment/reversal/redeem永久结果及引用（历史acquisition在迁移时核验） |
| Payment | settlement金额/currency/identity及预期效果、provider inbox/outbox/receipt等待/重试/死信；只返回状态与安全引用，不输出原始provider payload |
| Refund | 已观察退款与Credit effect分别核对、累计退款/累计冲正及零delta结果，不能因无journal就把合法零效果当缺失 |
| Subscription | trusted checkout/period/term/授权快照/credit关联、waiting期与eligibility状态；不按active/trialing推断已收款 |
| Checkout | offer revision/subject/account/provider/session绑定与unknown恢复deadline，过期URL不等于支付失败 |
| Metering | price revision、usage/admission/execution/hold/settlement关联与终态、unknown/lease/retry；外部事件identity与内部usage identity分别检查 |

必须在outer事务任何数据查询前设置READ ONLY REPEATABLE READ，配置局部预算后以首个快照建立查询取得as_of，再在该同一snapshot内执行检查；实现须有语句顺序测试。不使用SERIALIZABLE写锁，不导入或调用repair命令。固定as_of时间来自该事务，所有年龄/截止比较使用同一个时间基准。每个owner需双向orphan检查，不能只从父表出发；同仓跨owner关联通过具名引用页比较，SQL不跨owner模块。

分页为同一事务内稳定主键/复合键keyset，普通CRUD走Prisma类型API；聚合/反连接确需raw时另列最小白名单及解释计划，不用$unsafe。候选预算为page_size=200、单check最多10000个扫描root、单run最多50000 root、总deadline=30s、单statement上限2s、最多100条finding样本/check；均是工程上限不是实测SLO。root数不保证子表聚合成本有界，必须同时使用SQL预算/执行计划；每页重算剩余总预算、失败中止真实查询/rollback/drain，不能只Promise.race后留下查询。

扫描上限/期限耗尽、数据源超时或无法完成所有required checks时为incomplete，不把未扫描部分计ok；意外SQL/权限/Schema/解析错误为failed。finding样本截断与扫描不完整分开：完整扫描可报告准确总数并截断展示样本，只有扫描coverage完整才允许ok或完整drift。不得跨事务拼cursor续跑冒充同一snapshot；后续运行使用新的run_id/as_of并重新评价覆盖。

效果T1已接受但T2仍在owner合法等待窗口且具备有效任务/下一次检查时，计pending而非账务drift；超预算/死信/丢失任务按具名恢复code报告。future period、review_required、zero delta按D2规则分类，不统一拿一段任意grace掩盖错误。区分integrity/recovery/review类finding；unknown仍unknown，不自动补收款/发积分/冲账/重放。

### 保留与运维执行边界

首期显式采用preserve账务与幂等事实的保留profile：不自动清理业务表、不默设TTL或法定年限；runtime/reader均无删除能力。这不是已满足地区法规/备份恢复的声明。表/字段分类、引用及永久结果回放必须在迁移代码中验证；账务留存与敏感payload最小化分别处理，尚未证明裁剪后签名/重放/恢复正确的字段保持原样。

后续如需删除/脱敏，是单独批准的运维变更：先只读dry-run列出引用、未决任务、replay evidence、hold理由；没有完整保留policy/恢复证据/授权即不执行。不能通过清receipt或payment outbox腾空间，不能仅按published/expired判断可删；外部事件identity、digest、原始结果和source永久事实仍有回放作用时必须保留。此设计不强加新归档产品、legal-hold数据库表或通用maintenance服务作为本Goal新增功能。容量/旧任务告警与备份恢复证据仍需B10验收。
