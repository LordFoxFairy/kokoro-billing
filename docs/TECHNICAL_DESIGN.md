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
| payment | provider account/customer mapping、verified inbox、settlement；receipt/outbox经唯一数据库支持写入 | 核心不依赖其他feature；事件编排子模块显式导入其他owner，详见B8-D1；不写credit表 |
| credit | account/grant/hold/allocation/journal、acquisition/fulfillment/reversal、redeem；audit/outbox经共享支持写入 | grant/reserve/capture/release/reverse/fulfill及账本查询；在调用方同一事务scope内执行 |
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

## B8-D1 业务模块与事务目标（2026-09-10，内部设计已审查）

基线`ce5b6285e14e61f97dc16d1dd9d7dbc553358e66`，生产仍Fastify/pg。以下替代前文粗粒度目标表中尚未决定的共享writer与循环编排描述，
不改变下文标明的当前实现。整体业务重写仍须B8-D2契约/切换决定与机器Schema闭环；本节不是生产实施授权。

### 模块公开面与无环装配

唯一业务根为`src/modules/`下七个feature。公开入口为各`<feature>.public.ts`，显式导出业务Service、纯业务input/result与Nest module；
不公开Repository/ORM类型，不使用export-star、forwardRef、动态ModuleRef查找或全局业务provider绕过依赖方向。

| Feature | 可导入的其他feature公开面 | 唯一writer / 公开职责 |
|---|---|---|
| checkout | 无 | Offer/Revision、Checkout；catalog查询、发布、checkout claim/finalize；provider session client是本模块内部网络适配器 |
| payment（核心） | 无 | ProviderAccount/CustomerBinding、ProviderInbox、Settlement；映射查询、接受支付事实、settlement锁定快照、受控inbox重试 |
| credit | 无 | account/grant/hold/allocation/journal/acquisition/fulfillment/reversal/redeem；预留、扣除、释放、发放、冲正、到期及账户/账本查询 |
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
| CommandReceiptRepository | `general`、`payment`、`admission`固定映射三张receipt；claim/replay/complete | tenant+command+key与非空identity两套唯一性；admission另含apiSurface；成功result不可覆盖，损坏报内部不变量 |
| AuditAppender | 唯一audit表的append | trusted actor、operation、resource ref；成功审计与业务同一提交，不在回滚后伪造成功 |
| OutboxRepository | `credit`、`payment`固定映射两表；enqueue、claim、renew、ack、retry/dead-letter | 保留两表不同去重约束；payload/identity不可变；状态写比较scope+tenant+ID+token+非终态 |

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
| catalog/pricing发布 | receipt；offer或tenant pricing namespace锁；revision/rate、audit、result | pricing在tenant advisory锁后才分配MAX+1，保留UNIQUE；不同合法key必须都成功 |
| grant/redeem/subscription发放 | receipt或inbox；campaign/code或subscription/period；Credit全组、term、audit/outbox/result | 无provider网络；来源唯一性防同一period/payment/redeem重复发放 |
| authorize | admission receipt、invocation/admission；Credit account/grants/hold/allocation；admission/outbox/result | 定价快照属于Metering；included模式不虚构Credit hold |
| capture/release | receipt、admission；usage绑定；Credit account/grants/hold/allocation/journal；usage settlement、admission/outbox/result | 终态短路前先验证identity/digest；默认UUID成功与重放是必验，不用短ID代替 |
| expiry | batch receipt；按账户排序再重查eligible holds；Credit投影/allocations/outbox与精确expired IDs结果 | Redis仅协调；一次命令预算内处理有界batch，重放不扫描新对象 |
| settlement/退款效果 | 根settlement/reversal；Credit acquisition/fulfillment/grant/journal/reversal；audit/outbox/result | HTTP是否只接受事实、何时执行Credit由B8-D2冻结，禁止临时靠webhook补效果 |
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


### B7b 冻结方案修正（2026-09-10记录9月8日裁决）

TypeScript6.0.3 + typescript-eslint8.69.0 + ESLint10.10.0为本切片实际冻结版本；原8.70候选在安装当时未过pnpm默认发布冷却期，
不加豁免、不改变规则强度，采用相同peer且成熟的8.69。完整命令和版本证据见IMPLEMENTATION_PLAN的B7b执行中裁决。
JSON边界仅收紧非标量quote credit、非string provider reference与缺省parsed结果时的非法webhook ID/type，复用既有错误体系；
installer新增单元异常注入，保证falsey主异常不被资源关闭异常覆盖。文件归属/范围按任务板新增授权，不扩展生产owner/SQL/API。

独立已知P0：默认UUID hold加hold:前缀生成41字符usage ID，超过canonical VARCHAR(36)，真实capture报22001并回滚。
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
