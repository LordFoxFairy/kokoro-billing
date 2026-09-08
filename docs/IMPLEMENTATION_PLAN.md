# Billing TypeScript / Prisma 规范化任务板

日期：2026-09-08。唯一任务板；总范围是 Billing 工程收敛，不把第一轮审计视为整仓完成。

**Goal:** 按 Root TypeScript / SQL / API 手册明确 Billing 的模块、Prisma 数据访问、事务与契约方案，逐切片替换并验证。

**Architecture:** Billing 继续作为账务唯一 owner；按业务能力聚合 Nest module/provider，PostgreSQL 保持 durable authority，Redis 仅优化。Prisma 的 schema/锁/约束承接须经证据评审，禁止只安装依赖或保留双写就宣称完成。

**Tech Stack:** 当前 Fastify + pg + Zod 3；目标 Nest 12 + Prisma 7.10.0、SQL-first只读生成链，见ADR-0003；B6a已安装Prisma生成链；生产仍Fastify/pg，Nest与业务writer未切换。

## 基线与执行边界

- 工作目录：`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`。
- 分支：`codex/billing-ts-prisma-alignment`；起始 SHA：`7a193ba98f3e0554feb1cf7913919b8c36055e2c`。
- 初始 Billing 工作树干净。Root 已有 SQL 手册、Agent 子仓与 `.tmp/` 变更，全部排除；System/IAM 不在写入范围。
- B3期间主控为唯一writer；B4派发后由billing_owner唯一写入，主控停写本仓直到交接。Git index/commit始终由主控串行管理；审查员只读。
- 必读：Root `AGENTS.md`、`docs/CODEBASE_MAP.md`、手册 `03-sql-and-postgresql.md`、`08-typescript-backend-engineering.md`、API/事务/测试补充，以及本仓 README/INDEX/CURRENT/TECHNICAL_DESIGN/API_CONTRACT/DATA_MODEL/ADR。

## 任务卡

| ID / 优先级 / 目标 | Owner / 执行 / 审查 | 范围 | 依赖与验收 | 状态 / 交付 |
|---|---|---|---|---|
| B0 / P0 / 当前行为与门禁基线 | Billing / Root / 两位 reviewer | 只读源码、Git、工具链；本仓现有gate；主控独占临时验证资源 | 命令、退出码、pass/fail/skip、隔离与风险可追溯 | 已验收基线；Root失败另列 |
| B1 / P0 / Prisma与数据完整性审查 | Billing / billing_data_review（gpt-6-astra）/ Root | 只读SQL/数据访问/integration/数据文档 | 已复核安装目标错位、锁/约束/事务、BigInt与Prisma模式证据 | 已审查 |
| B2 / P0 / TS模块与契约审查 | Billing / billing_ts_review（gpt-5.6-sol）/ Root | 只读src/contract/test/CI/文档 | 已复核旧四层门禁、repository编排、HTTP混责与wire偏差 | 已审查 |
| B3 / P0 / 三文档与ADR收敛 | Billing / Root / B1+B2 reviewers | AGENTS、三文档、ADR-0003、CURRENT、本任务板及README/INDEX导航 | 当前态/目标态、唯一schema、契约策略一致；两位reviewer局部放行B4，完整重写门待验 | 已验收：9c890728c49458b38245682873273bd6d6b40d2c |
| B4 / P1 / 空库安装保护 | Billing / billing_owner（gpt-5.6-sol）/ B1+B2+Root | worker仅3个代码/测试文件；Root交接后更新database README、INDEX、CURRENT、ACCEPTANCE | 独占DB、TDD、非空/custom schema/并发/回滚/锁与JS超时/backend终止；主控提交/复验 | 已验收：93c06dfa33d38601e51534972890bfda50ea614d |
| B5 / P0 / 全量catalog drift | Billing / billing_owner / 数据+TS+Root | 精确文件集见B5执行卡；Root交接后文档与提交 | 比较canonical参照库的35表全部列/约束/索引/predicate；缺CHECK与错predicate反例 | 已验收：9663db58bd85eb810b94df6120de050530c79d2f |
| B6 / P0 / Prisma承接验证 | Billing / 后续续派billing_owner / Root | 固定依赖/生成链/模型/数据生命周期/独立验证；派前冻结文件集 | stable版本、无第二schema、typedCRUD+同tx锁/receipt/outbox+BigInt+错误+生成drift；不切生产writer | B6a待主控验收；B6b未开始 |
| B7 / P1 / 工具链与架构门 | Billing / 后续续派billing_owner / 独立reviewer | package/lock/TS/ESLint/format/CI/architecture精确集派前批准 | Node24、版本固定、完整typed gate；AST有效/违规样本替代禁modules/强制ports；单独格式切片 | 待派工；不放宽门禁 |
| B8 / P0 / Nest+Prisma闭合业务切换 | Billing / 后续续派billing_owner / Root+独立reviewer | 先完整35表映射/provider图/事务组卡，再授权src/SQL/contract/test/worker集 | 先稳定查询范式，后整个共享Credit事务组；同一事务不混pg/Prisma，旧实现随闭合切片删除；中间未闭合commit不发布 | 待设计门；依赖B5/B6/B7 |
| B9 / P1 / 契约与外部副作用 | Billing / 后续续派billing_owner / Root | owner contract先行；消费者另开owner任务，无本仓写入权 | envelope/request-id/UTC/error/202语义；checkout claim→网络→finalize及unknown恢复；实际消费者固定artifact | 待契约裁决/依赖B8 |
| B10 / P1 / 运行可靠性验收 | Billing / 后续续派billing_owner / Root | worker/reconciliation/retention/smoke与文档；派前批准文件集 | execution并发lease、orphan检测、append-only角色、预算取消、provider sandbox、CI PG16/镜像/DR分层证据 | 待派工 |

## 阶段门

- [x] B0：当前门禁与真实依赖基线已记录。
- [x] B1/B2：独立审查已接收并由Root复核。
- [x] B3：明确Prisma目标与当前差异，三文档一致；B4局部数据设计经billing_data_review放行。
- [ ] 完整业务/Prisma重写门：35表映射、完整drift、生成链/事务承接、breaking消费者裁决尚待验证。
- [x] B4交付、两阶段review、Root主工作树重跑验证与commit；见93c06df。

## B4执行卡（仅离线安装局部修复）

入口与API不新增公开业务能力。设计引用TECHNICAL_DESIGN顶部B4，不重复专项手册；新增两个角色文件，不建新目录。

- [x] 在`test/integration/schema-installation.test.ts`写行为反例；旧CLI已有view仍错误接受，已记录RED/GREEN。
- [x] 安装职责提取为`scripts/canonical-schema.ts`具名函数；入口只读环境/SQL并调用。
- [x] 全部schema URL值只允许public；实际public存在、有权限；固定READ COMMITTED、UTC/search_path与预算。
- [x] 同client事务/advisory lock后检查全部用户relations/独立types/functions，非空拒绝；DDL失败全回滚，不自动建/删schema。
- [x] 两个真实独立安装者一成一拒；锁占用预算内失败；原对象保持；中途DDL失败后再次安装成功。
- [x] 单文件测试独占随机database，管理连接仅创建/删除本轮随机名；未reset共享DB或FLUSH Redis。
- [x] worker运行lint/typecheck/build及21项integration后交付文件；未操作Git index。
- [x] Root规格审查→独立数据/TS代码审查→修复P1/P2→复审通过→主工作树全部gate重跑。后续同仓实现优先续派同一负责人。

实现负责人的测试命令：`DATABASE_URL=postgresql://nako@127.0.0.1:5432/postgres pnpm exec vitest run test/integration/schema-installation.test.ts --no-file-parallelism`。
该文件只以URL取得管理连接，所有安装/破坏性反例必须在它自身创建的随机database中，最终只清理自身数据库；不得把canonical SQL施加到postgres管理库。

## 审计证据摘要（源码基线7a193ba）

| 优先级 | 发现 / 源码定位 | 后续owner |
|---|---|---|
| P0 | `AGENTS.md:7`强制四层；`test/architecture/ownership.test.ts:110-154`禁止modules并强制ports；已修正文档，代码gate尚未切换 | B7/B8 |
| P0 | application转发与pg Repository真实编排错位：`src/application/payment/commands/billing-settlement-service.ts:8-11`、`src/infrastructure/postgres/repositories/payment/provider-event-processor.ts:47-138`跨context实现依赖 | B8 |
| P1 | `scripts/apply-schema.ts:20-30`检查public但connection允许自定义search_path；无完整catalog drift | B4/B5 |
| P1 | `src/infrastructure/postgres/repositories/checkout/checkout-service.ts:108-125`持锁调用provider | B9 |
| P1 | `src/infrastructure/postgres/connection.ts:24-27`缺PG锁/语句/idle transaction预算与UTC；环境读取越界 | B6/B8 |
| P1 | `src/interfaces/http/server.ts:117-149,268-305`混合错误/重试映射与request-id；全部route/schema/mapper集中一文件 | B8/B9 |
| P1 | `src/infrastructure/postgres/repositories/metering/usage-pricing-admin-service.ts:75-111`不同key并发MAX(revision)+1竞争；静态风险，未复现 | B8 |
| P2 | `database/schema.sql`表/PK/currency命名和opaque类型差异，nullable label UNIQUE、orphan/retention/append-only角色待收敛 | B5/B8/B10 |

行号只对应7a193ba，不指变化后的工作树。目标必须保留既有receipt/digest/result、tenant、并发退款、credit不变量、provider验签、Redis非权威测试，不删保护换工具。

## 实际证据

2026-09-08，源码7a193ba，Node22.22.2、实际pnpm12.3.4（manifest11.25.0未对齐）、本机PostgreSQL18.4；Redis已有6379实例。
日志本轮位于`/tmp/kokoro-billing-audit.nzdt2Y`；以下为持久化摘要，不依赖临时日志长期存在。

| 实际命令 | 结果 |
|---|---|
| `pnpm run lint` | exit0 |
| `pnpm run typecheck` | exit0 |
| `pnpm run build` | exit0 |
| `pnpm run sql:check` | exit0，canonical命名静态检查通过（不代表符合全部新SQL规范） |
| `pnpm run contract:check` | exit0，17route治理/parity |
| `env -u DATABASE_URL -u REDIS_URL -u REDIS_TEST_URL pnpm run test` | exit0，18文件通过/28跳过；84测试通过/80跳过 |
| `DATABASE_URL=<本轮临时database> pnpm run db:apply-schema` | exit0；同库重复安装exit1，预期非空拒绝 |
| `DATABASE_URL=<本轮临时database> REDIS_TEST_URL=redis://127.0.0.1:6379/4 pnpm run test:integration` | 28文件/80测试通过；首轮shell记录退出码时误用zsh只读status变量，中断的是包装脚本而非测试；后续全套重跑通过并清理 |
| 同临时database/Redis环境 `pnpm run test` | exit0，46文件/164测试通过，0失败0跳过 |
| Root `python3 scripts/verify-repository-topology.py` | exit0，PASS |
| Root `python3 scripts/verify-ten-repository-standard.py` | exit1，207条当前预检finding，其中Billing15条；含模块/工具链/format/TS strict/env边界，不表示207个运行时缺陷 |
| Root `python3 -m pytest scripts/tests` | exit1，82通过/2失败；`test_examples_extract_from_the_current_manuals`、`test_canonical_manuals_have_sources_and_balanced_code_fences`为既有手册/提取器期望差异 |

未运行：目标栈frozen install/Prisma generate（未接入）、format:check（脚本缺失）、CI PostgreSQL16、本次镜像build/smoke、真实支付provider sandbox、完整catalog drift、跨仓浏览器、生产故障/DR。
本地PG18.4不冒充CI16；Root失败不由Billing越界修复。临时database只清理本轮创建者，未重启或清空共享PostgreSQL/Redis。

## B4最终交付与集成证据

交付代码SHA：`93c06dfa33d38601e51534972890bfda50ea614d`；设计基线：`9c890728c49458b38245682873273bd6d6b40d2c`。
共享checkout无cherry-pick，Root是唯一commit owner。worker未暂存/提交；交接后Root补安装说明、CURRENT和ACCEPTANCE。

### 审查与修正

1. Root规格review退回遗漏procedure/range、SELECT星号、URL前置拒绝证据、失败清理和原对象保留；修正后数据reviewer放行。
2. TS reviewer发现checked-out pg client未监听error（P1）、JS deadline release路径与close预算（2项P2）；经真实backend终止和
   JS超时RED验证后修复。Pool/client listener保持至close完成，原始错误保留；最终TS reviewer复审无剩余P1/P2。
3. 数据reviewer与TS reviewer只读，结论绑定与93c06df一致的冻结代码；Root独立执行下面命令，不仅转述worker结果。

RED/GREEN证据：旧9c89072 CLI在独占库已有public view时exit0，marker=42、Billing表=35；当前CLI相同输入exit1，marker=42、
Billing表=0。连接故障反例修复前Vitest记录uncaught `Connection terminated unexpectedly`，JS deadline错误resolve；修复后
定向21项通过，无unhandled。最初的模块缺失0-test错误不作为业务RED依据。

### Root真实命令与结果

环境：Node22.22.2 / pnpm12.3.4 / PG18.4，复用Redis6379 DB4；每次创建`billing_accept_*`独占database，finally只清理本轮库。
新增fixture每用例自建`billing_schema_<random>`库，backend终止限定同库且包含随机query marker的自身PID。最终无这些临时库残留。

| 命令 | 实际结果 |
|---|---|
| `DATABASE_URL=<本轮库> pnpm run db:apply-schema` | exit0，35表；重复同命令exit1，预期非空拒绝 |
| 真实DB/Redis环境 `pnpm run verify` | exit0：lint/typecheck/build/sql:check/contract:check/test均通过，47文件/185测试通过，0失败0跳过 |
| 同环境 `pnpm run test:integration` | exit0，29文件/101测试通过，0失败0跳过 |
| `node dist/src/main.js` + curl真实HTTP | `/healthz`200、`/readyz`200、未认证catalog401、受信BFF catalog200；SIGTERM退出0 |
| `git diff --check` | exit0 |
| Root `python3 scripts/verify-repository-topology.py` | exit0 |
| Root `python3 scripts/verify-ten-repository-standard.py` | exit1，收尾快照208项/Billing15项；较初始207项新增的是并行IAM audit-events metadata finding，非Billing引入 |
| Root `python3 -m pytest scripts/tests` | exit1，82通过/2失败，与B0相同两项手册/提取器期望差异 |

SQL SHA256保持`57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd`；OpenAPI SHA256保持
`58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63`。B4未改业务Schema/contract/依赖。
首次native smoke管理psql继承角色`search_path=kokoro,pg_catalog`而失败；独占库已清理，改为显式public/UTC后重跑成功，未改全局角色设置。

仍未运行/未交付：B5全量drift、Prisma生成/运行、Nest业务重写、format门、Node24工具链切换、CI PG16、镜像RC、真实支付sandbox、
跨仓消费者与生产DR。SQL权限/目标拒绝测试不能替代全量数据库故障矩阵；pool.end极端驱动故障没有额外注入证据。
后续owner：Billing实现负责人续接B5；Root继续跨仓裁决/审查/最终验收；Root门禁问题归Root及各既有owner，保持可见不降门。

## B5 执行卡（全量 catalog drift）

- 基线：`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing` / `codex/billing-ts-prisma-alignment` / `d06274847c45215c8ba5cedbe44a5c938b3de20b`。Root 已先更新三文档与本卡，均为本切片设计，交接后 Root 停写 Billing。
- 设计门：本仓 `docs/TECHNICAL_DESIGN.md` B5 放置表、`docs/DATA_MODEL.md`、`docs/API_CONTRACT.md`；以这些绝对工作目录下文件为当前批准方案。未决：PG16真实执行、Prisma生成与业务迁移仍属后续门；B5无新的业务/API未决。
- 实现：billing_owner / gpt-5.6-sol / 唯一 writer；审查：billing_data_review + billing_ts_review 只读，Root集成。
- 允许文件：`scripts/schema-catalog.types.ts`、`scripts/schema-catalog.ts`、`scripts/schema-verification.ts`、`scripts/schema-database-session.ts`、`scripts/schema-verification.error.ts`、`scripts/verify-schema.ts`、`test/integration/schema-drift.test.ts`、`test/unit/schema-catalog.test.ts`、`test/unit/verify-schema.test.ts`、`test/unit/schema-verification-error.test.ts`、`package.json`、`.github/workflows/ci.yml`。如确需共用生命周期 helper，先报告具体位置/职责，由Root调整范围。
- 排除：canonical SQL、contract、src、lockfile、所有其他仓；不改B4已验代码，文档收尾由Root交接后写。共享checkout的暂存/commit/分支由Root独占，worker交付文件清单与证据。
- TDD：完整正例35表；删CHECK、同名改predicate、列type/precision/default/nullability、缺表/列/索引/UNIQUE、额外表/FK/type/function反例；目标数据保持、只读角色、配置拒绝和参照清理。覆盖差异比较排序/空白字面量保留；不用新增人工schema快照。
- 验证：定向测试用 DATABASE_URL=postgresql://nako@127.0.0.1:5432/postgres 仅创建自有测试库；全套测试只在Root创建的本轮独占database运行。复用PG5432/Redis6379，禁止清理共享数据或启动服务。
- 交付：实现负责人运行lint/typecheck/build与定向真实集成；Root复核SQL/OpenAPI hash、负例、完整verify/integration、CLI正反例、清理和diff后按切片提交。不得把目标整体标完成。

B5 设计补充已由 Root 接受：relpersistence 防 UNLOGGED 假通过、RLS/trigger/rule/policy、数据库 encoding/locale/provider、创建结果未知不猜测清理；新增 session helper 授权已记录。
2026-09-08 实现负责人首轮交付：24 integration + 1 unit通过；Root开始独立审查与全套复验，尚未验收/提交。

## B6/B8 前置只读调查：35 表当前 writer（非业务切换放行）

2026-09-08，billing_data_review 只读源码 d062748；Root复核目标owner。下表是事实盘点，不把未装配类/seed能力当已上线API。
所有writer简称对应现有 `src/infrastructure/postgres/repositories` 中类；PG OutboxWorker为基础dispatch更新者。

| 当前表 | 直接 SQL writer | 目标 owner / 待细化 |
|---|---|---|
| entitlement_credit_account | AdminGrant、AccountQuery、Redeem、GrantExpiry、SubscriptionGrant、ProviderEventProcessor、BillingSettlement、BillingAdmission、UsageSettlement、BillingReversal | credit |
| entitlement_credit_grant | AdminGrant、Redeem、GrantExpiry、SubscriptionGrant、BillingSettlement、UsageSettlement、BillingReversal | credit |
| entitlement_credit_hold | UsageSettlement | credit |
| entitlement_credit_hold_allocation | UsageSettlement | credit |
| entitlement_credit_journal | AdminGrant、Redeem、GrantExpiry、SubscriptionGrant、BillingSettlement、UsageSettlement、BillingReversal | credit的ledger能力 |
| entitlement_usage_event | UsageSettlement | metering |
| entitlement_usage_settlement | UsageSettlement | metering |
| entitlement_command_receipt | AdminGrant、RedeemAdmin、CatalogAdmin、UsageSettlement、UsagePricingAdmin | 各用例模块；共享物理writer待设计 |
| entitlement_outbox | AdminGrant、Redeem、GrantExpiry、SubscriptionGrant、BillingSettlement、UsageSettlement、BillingReversal；OutboxWorker具备更新能力 | credit；dispatch待设计 |
| payment_provider_event | ProviderEventProcessor、ProviderEventAdmin、ProviderEventInbox | payment |
| payment_settlement | BillingSettlement | payment |
| payment_reversal | BillingReversal | refund |
| entitlement_acquisition | SubscriptionGrant、BillingSettlement | credit |
| entitlement_fulfillment | SubscriptionGrant、BillingSettlement | credit |
| payment_outbox | ProviderEventAdmin、ProviderEventInbox、BillingSettlement、BillingReversal、运行时OutboxWorker | payment/refund共享writer待设计 |
| entitlement_fulfillment_reversal | BillingReversal | credit |
| payment_checkout | Checkout | checkout |
| entitlement_audit_event | AdminGrant、RedeemAdmin、ProviderEventAdmin、CatalogAdmin、UsagePricingAdmin、BillingReversal | 实际跨模块audit待设计，不能按前缀强归credit |
| entitlement_offer | CatalogAdmin（seed-only） | checkout |
| entitlement_offer_revision | CatalogAdmin（seed-only） | checkout |
| entitlement_usage_price_revision | UsagePricingAdmin（seed-only） | metering |
| entitlement_usage_price_rate | UsagePricingAdmin（seed-only） | metering |
| payment_provider_account | seed脚本，src无writer | payment |
| payment_customer_binding | src/scripts未发现writer | payment |
| payment_provider_subscription | ProviderEventProcessor | subscription |
| payment_subscription_period | ProviderEventProcessor | subscription |
| entitlement_subscription_term | ProviderEventProcessor | subscription |
| payment_command_receipt | ProviderEventAdmin、BillingSettlement、BillingReversal | payment/refund共享writer待设计 |
| entitlement_redeem_campaign | Redeem、RedeemAdmin（未装配） | credit |
| entitlement_redeem_code_batch | RedeemAdmin（未装配） | credit |
| entitlement_redeem_code | Redeem、RedeemAdmin（未装配） | credit |
| entitlement_redeem | Redeem（未装配） | credit |
| entitlement_billing_command_receipt | BillingAdmission | metering |
| entitlement_billing_admission | BillingAdmission | metering |
| entitlement_execution_event | BillingAdmission | metering |

关键事务组：settlement acceptance（payment receipt/settlement/outbox/result）；fulfillment（锁settlement + account/acquisition/fulfillment/grant/journal/entitlement outbox）；
refund（累计金额锁 + payment receipt/reversal/audit/payment outbox + credit reversal）；admission/capture/release/execution（billing receipt/admission/execution/usage + credit hold/allocation/account/grant/journal/outbox）；
expiry（batch receipt + hold/allocation/account/outbox + exact result）；subscription event（inbox状态 + subscription/period/term + credit grant）；catalog/pricing（receipt + revision/rate + audit）。
Outbox claim/续租/ack/retry与handler事务分离。ProviderEventProcessor外层application已有事务，内层savepoint复用同连接，不能误判为多个物理提交。

待Root在B8设计门裁决：共享receipt/audit/outbox唯一物理writer与各用例的事务内公开能力；UsageSettlement的metering/credit职责拆分；
ProviderEventProcessor跨payment/subscription/credit/refund编排；AccountQuery.ensureForSubject包含INSERT，不得将整类作为只读切片。
AdminGrant/Redeem/RedeemAdmin/ProviderEventAdmin未发现运行入口；payment worker仅装配payment_outbox且处理PaymentProviderEventReceived，未有完整entitlement dispatch。

2026-09-08版本再核验：prisma/client/adapter-pg 7.10.0仍可用；adapter使用pg ^8.16.3，Nest core12.0.1与platform-fastify12.0.1可用，
后者依赖fastify5.12.1。仅npm view元数据，不是已安装兼容证据。官方[db pull](https://www.prisma.io/docs/cli/v7/db/pull)提供config与--print/--force，
[Client生成](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/generating-prisma-client)要求显式output；后续仍用固定版本本地exec，不用浮动dlx。

## B5 审查、交付与主控证据

基线 d062748，Root唯一提交负责人；实现billing_owner，数据billing_data_review、TS billing_ts_review均已最终放行，无剩余已报P1/P2。
Root交接后仅补三设计面、CURRENT/ACCEPTANCE、README/INDEX/database README和本卡；其他仓/SQL/contract/lockfile/src均未修改。

审查修正：
- relation加入persistence/RLS和额外trigger/rule/policy，避免UNLOGGED/行为对象漏检；数据库locale加入ICU rules。
- target identity先只读事务、限定系统函数，真实public.current_setting同名函数写入反例证明未执行、marker不变。
- 补同名partial index改predicate；定义用JSON组合，保留字面量，不手写第二Schema。
- 有界session处理connect/query/backend error/close；JS deadline反例先将server预算调至5s，使100ms JS路径独立受测。
- primary/cleanup错误分槽并显式失败哨兵；保留falsey rejection；安全资源错误图可穿过Aggregate/cause且防环，只输出受控随机名，不泄露URL/秘密。
- reference清理测试按前后集合而非全局零；当前串行验收成立，不声明其他检查器同时增删参照时的完全隔离。CREATE结果未知不猜测DROP。

真正RED/GREEN：新增能力在d062748缺失；开发中fixture错误不当业务RED。Root对冻结实现独占库删除CHECK后CLI真实exit1、报告missing，
完整canonical CLI exit0。两轮review发现的旧实现缺口与修复后真实反例另见上述条目；不以最终测试数量倒推所有反例曾在旧提交执行。

2026-09-08 Root冻结代码验证：Node22.22.2 / pnpm12.3.4 / PG18.4 / Redis6379 DB4，管理角色nako；创建并只清理本轮billing_accept_b5_*。
定向fixtures自建billing_drift_*、billing_schema_*，参照库仅本轮billing_reference_*；没有共享reset/FLUSH/服务重启。

| 命令 | 实际结果 |
|---|---|
| `pnpm db:apply-schema` | exit0 |
| `DATABASE_URL=<本轮库> SCHEMA_ADMIN_URL=<同实例postgres管理库> pnpm db:verify-schema` | exit0；35 relations、368 columns、127 constraints（NOT NULL由列比较）、83 indexes，0差异 |
| 同本轮库删除一个CHECK后再次 `pnpm db:verify-schema` | exit1，精确missing约束；只对本轮库反例 |
| 真实DB/Redis环境 `pnpm verify` | exit0；lint/typecheck/build/sql:check/contract:check/test；51文件217测试通过，0失败0跳过 |
| 同环境 `pnpm test:integration` | exit0；30文件129测试通过，0失败0跳过 |
| `git diff --check` | exit0 |
| Root topology | exit0 |
| Root standard | exit1，208条/Billing15条，既有缺口仍待后续切片 |
| Root `python3 -m pytest scripts/tests` | exit1，82通过/2既有handbook失败，与B4相同 |

SQL SHA256仍57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd；OpenAPI仍58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63。
未运行：PG16 CI（已接db:verify-schema步骤）、专门ICU rules运行反例、极端驱动release/close同步抛错注入、镜像/provider sandbox、Prisma/Nest、format门、跨仓消费者/生产DR。
B5 runtime src不变，B4原生HTTP smoke是历史回归证据，不冒充本轮新smoke。B6下一步先复用现有生成/参照生命周期经验设计稳定Prisma生成与承接验证，不直接迁业务。

B5交付SHA：`9663db58bd85eb810b94df6120de050530c79d2f`，共享checkout由Root提交，无cherry-pick。
Root在该干净HEAD重新执行db:apply-schema、verify（217/217，51文件）、test:integration（129/129，30文件），随后按CI顺序执行db:verify-schema（0差异），全部exit0，0失败0跳过。
所有本轮已确认创建的临时库已清理；本轮未更新其他仓。阶段B5已验收，整体Goal继续active，B6–B10未完成。

## B6 执行卡：生成链先行、事务承接随后

- 基线：`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，分支codex/billing-ts-prisma-alignment，2a2be5a6ece557316d369decf9cdee23f59afd8a；Billing干净，Root其他既有改动排除。
- 当前设计：本仓docs/TECHNICAL_DESIGN.md B6放置门、docs/DATA_MODEL.md、docs/API_CONTRACT.md和ADR-0003；Root已统一三面，无业务/API改动，完整业务writer/provider边界仍为B8未决。
- writer：billing_owner（gpt-5.6-sol）；review：billing_data_review与billing_ts_review，Root复核/提交；同仓单一writer、不Git操作，沿用前两切片机制。
- B6a允许集：package.json、pnpm-lock.yaml、pnpm-workspace.yaml（必要Prisma build allowlist及ADR-0003 scoped安全覆盖）、.gitignore、.dockerignore、Dockerfile、tsconfig.json/tsconfig.build.json、eslint.config.mjs、.github/workflows/ci.yml、prisma.config.ts；
  scripts/canonical-reference.ts、scripts/schema-verification.ts、scripts/schema-verification.error.ts（仅复用生命周期）、scripts/prisma-generation.ts、scripts/prisma-generation.types.ts、scripts/prisma-generation.constants.ts、scripts/prisma-refresh.ts、scripts/prisma-check.ts、scripts/prisma-process.ts、scripts/prisma-artifacts.ts（收尾经Root批准的产物一致性职责）；
  database/generated/schema.prisma、database/generated/provenance.json（仅生成）；src/generated/prisma/**（仅生成且gitignored）；
  test/integration/prisma-generation.test.ts、test/unit/prisma-generation.test.ts、test/architecture/prisma-generation.test.ts。普通文件确需不同职责先报告调整，不机械创建全部候选文件。
- B6b允许集在B6a生成/类型门通过后续派：test/fixtures/prisma-database.ts、test/integration/prisma-persistence.test.ts；依赖和scripts额外变动先报告。生产src除generated全部排除，SQL/contract/其他仓排除。
- 交付要求：从canonical临时库实际生成35模型，无CHECK/partial predicate丢失后假schema一致的声明；两次生成相同、schema/client篡改只报错不修复、离线generate/build，源码与编译Client真实连接smoke；完整B5与原业务回归不破坏。
- 安全：SCHEMA_ADMIN_URL=postgresql://nako@127.0.0.1:5432/postgres仅作管理，SQL只施加自有随机库。复用PG5432/Redis6379，禁止reset/FLUSH/终止其他服务；目标/管理URL和临时路径不可进入生成物。
- 状态：B6a实现交回、数据/TS独立复审已放行，主控验收中；B6b待B6a证据。所有commit由Root，worker报告命令/实际计数/依赖变动与风险；不将B6a安装/生成称为完整B6或整仓完成。

## B6a 审查与主控证据（生成治理，不是业务迁移）

2026-09-08，基线2a2be5a加B6a冻结实现。billing_owner为唯一实现writer，Root负责设计文档/提交；
billing_data_review（数据/规格）与billing_ts_review（TS/生命周期）已独立复审放行，无剩余已报阻断项。
Root交接后更新三设计面、ADR、CURRENT、README、database README、AGENTS、INDEX与本任务板，不改其他仓。

本切片实际交付：固定Prisma/client/adapter7.10；SQL→独立template0参照→空bootstrap introspection→validate/generate；
只读schema/provenance入Git，Client忽略并在消费前离线生成；check比较完整文件集合/字节，不发布；refresh受独占锁保护发布/失败回滚。
35模型与SQL表/字段集合一致。SQL/OpenAPI字节未变，业务src除生成物未变，B6b/生产writer/七模块仍未交付。
生成文件的partialIndexes、JS import扩展名及scoped依赖安全覆盖均为Root审查后的明确裁决，见ADR-0003。

审查修正及真实反例：
- 将“generate后输入schema没变”替换为两次不同随机database/临时输出目录的完整生成/全文件比较，真实Client/schema篡改、缺失和额外文件受测。
- Root实际malformed URL命令曾打印SECRET_FIXTURE（RED）；两CLI安全入口后同一命令exit1且秘密不出现（GREEN）。
- timeout由专属process group处理TERM/KILL并等待组消失；真实父子进程（子忽略TERM）测试，ESRCH正常退出竞态不报cleanup失败。
- 发布先准备/备份/替换、失败逆序还原；rename故障反例证明旧schema/Client保持；受控交错证明第二publisher拒绝、持有者成套发布。
- primary、rollback、staging/lock/backup cleanup保留原错误与Aggregate/cause；CLI只安全展示受控信息，不打印原连接错误。
  清理双故障与ESRCH分支本轮有代码复审，无专门故障注入测试，不把它们算作已运行反例。

Root实际工具链：`/bin/bash` login=false，Node22.22.2、pnpm11.25.0，PG18.4、共享Redis6379 DB4。
本机默认zsh另解析Node24.20.0；不能把不同shell工具链混称。本轮只创建/清理自身billing_accept_b6_*及tests自有随机库，无共享reset/FLUSH/服务重启。

| 命令 | 实际结果 |
|---|---|
| `pnpm install --frozen-lockfile` | exit0，pnpm11.25.0 |
| 独占database `pnpm db:apply-schema` | exit0 |
| 同库、SCHEMA_ADMIN_URL及REDIS_TEST_URL环境 `pnpm verify` | exit0；lint/typecheck/build/sql:check/contract:check/test；54文件228测试通过，0失败0跳过 |
| 同库 `pnpm db:verify-schema` | exit0，35表368列127约束83索引，0差异 |
| `pnpm prisma:check` | exit0；对当前全部schema/provenance/Client重建比较 |
| `node --input-type=module` 导入dist Client，经PrismaPg读取本轮测试库 | exit0，真实count=17；另独占空库count=0 |
| `pnpm audit --json` | exit1，5项既有问题：esbuild/vite/vitest，3 moderate+1 high+1 critical；新增Prisma传递依赖公告经scoped覆盖消除，B7处理既有项 |
| `git diff --check` | exit0 |

SQL SHA256仍57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd；OpenAPI仍58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63。
B5/本轮定向复验由worker为7文件43项通过，不替代上述Root完整门禁。Owner两次刷新完整产物哈希相同的报告由独立真实生成测试复核，
不把手工刷新等同长期自动化覆盖。详细CLI隔离反例与交付SHA在提交时补记。

未运行/剩余范围：Docker info探测超时，未构建镜像/运行PG16 CI；未声称Trivy全绿。format门/旧依赖审计归B7，
stdout收集上限、清理双故障注入为后续hardening；Prisma typed业务事务、部分唯一索引并发、BigInt/JSON/UTC语义归B6b，
Nest/单一Credit writer/旧pg业务删除归B8，契约消费者/checkout外部调用与可靠性归B9/B10。目标保持active。

Root命令级补验：在本轮临时镜像目录复制必要源码/生成物并链接依赖，直接`node --import tsx scripts/prisma-check.ts`：
原始产物exit0；仅篡改schema后exit1、报告schema路径且篡改字节保留；恢复后仅篡改Client再次exit1、报告Client路径且字节保留；
全部恢复后exit0。两CLI分别以带SECRET_FIXTURE的malformed管理URL执行，均exit1且输出无该秘密。
最初镜像调用pnpm exec因未复制workspace策略触发自动安装/ignored builds而失败，这是验证fixture问题，非生成链反例；
改直接Node入口后成功，主仓随后frozen install复核exit0，临时目录已清理。最终提交后重跑全门，不继承该次自动安装环境。
