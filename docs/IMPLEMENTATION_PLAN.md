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
| B6 / P0 / Prisma承接验证 | Billing / 后续续派billing_owner / Root | 固定依赖/生成链/模型/数据生命周期/独立验证；派前冻结文件集 | stable版本、无第二schema、typedCRUD+同tx锁/receipt/outbox+BigInt+错误+生成drift；不切生产writer | 已验收：B6a c7ef9fa；B6b 2793882；生产迁移仍归B8 |
| B7 / P1 / 工具链与架构门 | Billing / billing_toolchain_hardening / 独立reviewer | package/lock/TS/ESLint/format/CI/architecture精确集派前批准 | Node24、版本固定、完整typed gate；AST有效/违规样本替代禁modules/强制ports；单独格式切片 | B7a已验收058bdf3；B7b已验收3fd97f5；B7c已提交8fbf8e0、双审/冻结树全验通过，待干净HEAD复验；B7d待实施，不放宽门禁 |
| B8 / P0 / Nest+Prisma闭合业务切换 | Billing / 后续续派billing_owner / Root+独立reviewer | 先完整35表映射/provider图/事务组卡，再授权src/SQL/contract/test/worker集 | 先稳定查询范式，后整个共享Credit事务组；同一事务不混pg/Prisma，旧实现随闭合切片删除；中间未闭合commit不发布 | 待设计门；依赖B5/B6/B7 |
| B9 / P1 / 契约与外部副作用 | Billing / 后续续派billing_owner / Root | owner contract先行；消费者另开owner任务，无本仓写入权 | envelope/request-id/UTC/error/202语义；checkout claim→网络→finalize及unknown恢复；实际消费者固定artifact | 待契约裁决/依赖B8 |
| B10 / P1 / 运行可靠性验收 | Billing / 后续续派billing_owner / Root | worker/reconciliation/retention/smoke与文档；派前批准文件集 | execution并发lease、orphan检测、append-only角色、预算取消、provider sandbox、CI PG16/镜像/DR分层证据 | 待派工 |

## 阶段门

- [x] B0：当前门禁与真实依赖基线已记录。
- [x] B1/B2：独立审查已接收并由Root复核。
- [x] B3：明确Prisma目标与当前差异，三文档一致；B4局部数据设计经billing_data_review放行。
- [ ] 完整业务/Prisma重写门：catalog drift、生成链及隔离事务承接已通过；35表目标writer/provider图、真实业务事务组与breaking消费者裁决仍待完成。
- [x] B4交付、两阶段review、Root主工作树重跑验证与commit；见93c06df。
- [x] B5完整catalog drift与B6a/B6b生成/隔离事务承接已验收；下一切片B7，不代表生产Prisma切换。

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
- B6b允许集在B6a生成/类型门通过后续派：test/integration/prisma-database.fixture.ts、test/integration/prisma-persistence.test.ts；依赖和scripts额外变动先报告。生产src除generated全部排除，SQL/contract/其他仓排除。
- 交付要求：从canonical临时库实际生成35模型，无CHECK/partial predicate丢失后假schema一致的声明；两次生成相同、schema/client篡改只报错不修复、离线generate/build，源码与编译Client真实连接smoke；完整B5与原业务回归不破坏。
- 安全：SCHEMA_ADMIN_URL=postgresql://nako@127.0.0.1:5432/postgres仅作管理，SQL只施加自有随机库。复用PG5432/Redis6379，禁止reset/FLUSH/终止其他服务；目标/管理URL和临时路径不可进入生成物。
- 状态：B6a已验收c7ef9fa；B6b已交付2793882，最终证据见本任务板末尾。所有commit由Root，worker报告命令/实际计数/依赖变动与风险；不将B6a安装/生成称为完整B6或整仓完成。

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


### B6a 交付与干净HEAD复验

交付SHA：`c7ef9fa95c75fb6dfb789032220e2f5f2c53415a`。同一共享checkout由Root提交，无cherry-pick。
Root在该干净HEAD重新运行：frozen依赖已确认，db:apply-schema通过；`pnpm verify`为54文件228/228；
独立`pnpm test:integration`为31文件132/132；随后按CI顺序执行db:verify-schema（0差异）与prisma:check（0差异），
编译Client真实PG查询通过。以上exit0、0失败0跳过；测试后工作树仍干净，退出清理本轮数据库。
本轮Root topology再跑PASS；Docker info再次5秒超时，未启动/重启Docker或尝试镜像构建。

B6a局部三文档门：
- `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md`
- `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md`
- `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md`

三面在c7ef9fa中一致：只读生成治理无业务契约/SQL变更；`contract:check`17route通过、SQL/catalog/Prisma生成门通过。
未决项明确为B6b真实事务承接、B8共享writer/provider图与SQL命名切换、B9消费者/外部副作用、B10完整运行门，不扩大为完整业务重写放行。
下一步Root按本卡续派billing_owner实施B6b的两份隔离测试文件，先真实行为验证，不新增生产模块，不触及其他仓。


## B6b 执行卡：Prisma 真实事务承接证明

2026-09-08；基线b05034ecb05f527d031959068ba52ff23fc457f4，codex/billing-ts-prisma-alignment，Billing干净。
前轮分类为进展：B6a实现c7ef9fa已提交并通过全门，不是状态重复。当前B6b开始实施，整个Goal仍保持原范围。

| 项 | 决定 |
|---|---|
| Owner / writer | Billing；billing_owner（gpt-5.6-sol）唯一writer；Root架构/提交，数据与TS reviewer只读 |
| 范围 | 仅test/integration/prisma-database.fixture.ts与prisma-persistence.test.ts；Root交接后更新技术/数据/任务板证据；其他源码/配置/Schema/API/Git由worker排除 |
| 目录比较 | 原计划test/fixtures尚不存在且仅一个fixture，改用现有test/integration的角色后缀文件；不放入scripts或生产database模块，不创建空目录 |
| API / 生命周期 | 测试fixture使用withCanonicalReference复用自有template0数据库；PrismaPg管理本fixture pool，显式connect/disconnect、预算/UTC/search_path；所有tx同一Prisma TransactionClient，结束后释放再删自己DB |
| 依赖与数据 | B6a生成Client与canonical SQL不变；不改变17条HTTP契约；普通CRUD typedClient；raw仅set_config/pg_backend_pid/txid/锁与SKIP LOCKED及预算探针；禁止unsafe raw与其他owner访问 |
| 验证 | 同tx receipt/account/journal/outbox全部提交与失败全回滚；双连接可见性；CHECK与key UNIQUE；同identity不同key并发partial UNIQUE；同tenant限定FOR UPDATE等待/释放、SKIP LOCKED不抢同行；事务/语句/锁预算；BigInt超safe精确存取+现有安全数值边界、JSON DbNull/JsonNull/UTC毫秒 |
| 删除 | 不生成第二schema、mapper/error兼容层、生产Prisma服务或应用pg替身；fixture仅是能力证据，业务替换须B8完成 |
| 交付 | Worker先验证反例与实际错误形态，再交回；不伪造RED、不把fixture导入缺失当业务RED。Root规格/独立审查后重跑verify、integration、catalog/prisma check，明确路径暂存小切片 |

具体测试判定：并发使用显式握手或PG锁状态，不只靠sleep猜调度；记录不同pg_backend_pid及同事务tx身份。
数据库行更新与结果/事件JSON写入使用生成类型，金额不经Number损失精度；超过safe范围写入数据库可保持bigint，当前API安全数值策略继续明确拒绝。
JSON null使用Prisma.DbNull/JsonNull和typed filters证明区分；同一Date instant采用UTC存取并保留毫秒。
CHECK/UNIQUE/事务冲突报告Prisma7.10+adapter-pg实际错误code/meta语义，SQLSTATE若未公开不编造映射；B8再绑定业务错误体系。
仅复用已有PG5432/Redis6379，不共享reset/FLUSH，fixture只创建/清理随机reference库，测试不需要Redis。

官方语义2026-09-08重新读取：Prisma v7 transactions（maxWait/timeout/isolationLevel、同tx单连接、P2034）和JSON字段（DbNull/JsonNull）；
官方页面通过curl读取.md，web读取端不支持text/markdown。现有已安装adapter声明确认pool config/externalPool所有权及disposeExternalPool选项。
技术/数据/API三面仍依B6门：仅新测试，无生产事实更改；完整业务重写未决仍为B8的writer/provider/SQL命名与B9契约消费者。

## 并行只读调查：B7 与 B8 准备（尚未实施）

B6b writer工作期间，billing_ts_review完成B7工具链调查，Root检查真实事务调用链；未修改生产源码/依赖/其他仓。

B7当前证据与Root候选：Node24.20.0统一本地/CI/镜像，单一`.node-version`；保留pnpm11.25.0；
Vitest5.0.0作为当前稳定候选（官方发布仅数日，v2→v5跨major风险需完整实跑，不凭latest标签放行）；
Vite8.2.2作为对应peer候选，是否直接声明由实际安装关系决定，不引入无生产消费者的bundler。
当前生产依赖先精确pin已验证lock解析，Nest/Zod等major按自身切片评估，不夹带无关升级。
开发门采用recommendedTypeChecked覆盖全部手写TS、Promise/unsafe/exhaustiveness与大小写一致，独立纯格式切片，
AST架构门替换禁modules/强制ports；正反例证明非法依赖被拒，合法模块允许，不靠禁词制造绿色。
完整目录/provider图归Root B8裁决，B7不把目标结构宣称为已运行结构；有效tenant/SQL/权限保障不随旧形状门删除。

版本来源（2026-09-08 reviewer只读核验）：Node官方previous-releases/dist index；npm view vitest/vite engines/peers/dist-tags；
Vitest migration官方文档。报告确认旧esbuild/Vite/Vitest共5项公告仍在；最小安全线不等于当前目标最新版。
Root尝试直接读取Docker官方registry Node24.20.0-bookworm-slim manifest，auth端TLS EOF而失败，未获得可信digest；
不得捏造镜像SHA，B7实际依赖/镜像操作前重新验证。此问题不阻塞当前本地Prisma测试与其他实现。

### B8 新的真实基线证据

Root在仅自己创建的canonical参照库中运行现有真实inbox.accept→ProviderEventProcessor.process；注入缺失provider的已持久事件，
业务抛出`billing.provider_not_enabled`后读取结果为`processing_status=received, processing_attempts=0, last_error=null`。
原因是`application/payment/commands/provider-event-processor.ts`外层withTransaction包住内部catch/markFailed/rethrow，
失败记录随业务事务回滚（`infrastructure/postgres/repositories/payment/provider-event-processor.ts`约57–78行）。
不是声称handler已记录失败；B8/B10须在业务回滚结束后设计受控独立失败记录，保留幂等/未知提交语义，不能机械搬旧实现。
本轮只读现有源码及操作独占fixture，没有修改实际provider入口或生成第二协议。

B8依赖设计必须同时解决Payment事件编排→Refund与Refund→Payment settlement锁的潜在Nest循环：
不能用forwardRef/ModuleRef掩盖。候选之一是Payment基础事实Module保持leaf，PaymentEvents子能力Module只在worker组合根
导入Payment/Refund/Subscription/Credit等公开服务；另一个是拆Payment内明确的Settlement公开子能力。最终provider图仍待Root在B8统一裁决，
不让不同worker各造一个边界。当前处理器的subscription/account直接写入须分别移交对应owner，不能只移动文件。


## B6b 审查收敛与验证记录

基线b05034e；writer billing_owner，数据/规格billing_data_review、TS/生命周期billing_ts_review，Root最终审查/提交。
实际新增2文件：`test/integration/prisma-database.fixture.ts`、`test/integration/prisma-persistence.test.ts`，生产src/SQL/contract/依赖字节不变。

全部审查缺口已修：
- fixture初始化失败关联ready拒绝，完整关闭Client/pool/参照；配置前置拒绝有反例，不冒充所有资源故障已注入验证。
- key UNIQUE采用实际winner key+新identity，partial UNIQUE采用相同identity+不同key并发；不同tenant用相同identity/key仍允许。
- Root真实探针证明无timeout的pg_sleep void结果也会P2010；改可解码probe，锁55P03与statement57014、交互P2028分别断言。
- 持锁任务失败传播至acquired；finally release并回收所有task，成功路径await holder防止超时回滚被误当成功释放。
- Root实测Prisma25ms interactive timeout不终止JavaScript gate：150ms仍pending，显式release后才得原错/P2028。
  并发arrival具失败通道，早期故障等待另一worker到达后再抛原始marker，finally释放/回收；正常并发重新清空PID收集，避免依赖pool复用。
- 单事务组不只count：receipt succeeded/result与account余额显式检查，journal/outbox写入同事务并检查总数；失败组不留事实，外连接看不到未提交账户。

Root阶段验证（Node22.22.2/pnpm11.25.0/PG18.4/Redis DB4）：前一冻结版完整verify55文件233项、独立integration32文件137项，
catalog35表368列127约束83索引0差异，prisma:check通过；最后holder/PID/barrier修正后需最终HEAD重跑，以下提交验收记录为准。
Root已独立运行holder修正后的5项及lint/typecheck/build；barrier/PID最后版由worker运行5项通过并交回，尚不以worker计数取代Root最终验证。

审查最终范围只放行Prisma隔离能力，未宣称production转换；完整35表业务迁移、异常归一与deadlock/serialization/未知提交恢复仍B8，
原5项依赖公告与format门归B7。Root未触碰SQL手册、其他仓、共享基础设施，未运行Docker/PG16 CI/provider sandbox。


### B6b 交付与干净 HEAD 最终验收

交付：`27938824a064893a1d8f201fd3e3c9d8042ce579`，共享checkout由Root提交，无cherry-pick。
Root先在最后barrier/PID版本独立跑5项真实PG测试通过，再提交；下列全门均在该干净HEAD运行，测试期间无人写入。
环境：`/bin/bash` login=false，Node22.22.2、pnpm11.25.0、PostgreSQL18.4、Redis6379 DB4。
管理连接只用于创建/删除本任务随机database；完整suite使用独占`billing_accept_b6b_*`，退出trap已删除。
日志目录为`/tmp/billing-b6b-final.vATRpo`；持久验收事实如下，不依赖临时日志存在。

| 实际命令 | 结果 |
|---|---|
| `pnpm db:apply-schema`（独占空库） | exit0 |
| `pnpm verify` | exit0；lint/typecheck/build/sql:check/contract:check/test全通过，55文件233测试，0失败0跳过 |
| `pnpm test:integration`（同独占库） | exit0；32文件137测试，0失败0跳过；此集合包含于上行，不相加计数 |
| `pnpm db:verify-schema` | exit0；35表368列127约束83索引，differences为空 |
| `pnpm prisma:check` | exit0；完整生成集合无差异 |
| `git diff --check` / `git status --short` | exit0 / 无输出，测试后工作树干净 |

canonical SQL SHA256：`57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd`；
OpenAPI SHA256：`58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63`，均未变。
独立数据/规格与TS/生命周期review已放行；Root额外要求PID集合隔离后完成上述最终复验。
局部三文档门仍为本仓TECHNICAL_DESIGN、API_CONTRACT、DATA_MODEL（绝对路径见B6a门报告）：
本切片仅新增隔离测试，API/Schema不变；此门不放行尚未明确的B8共享writer/provider图与B9契约变化。

B6a+B6b标记已验收，Goal保持active且范围不缩减。下一任务为B7，由Root冻结工具链/架构门设计与精确写入卡，
再续派billing_owner；生产迁移归B8，外部调用与消费者归B9，完整可靠性归B10。
本切片未运行format:check（尚无脚本）、PG16 CI、镜像、provider sandbox、跨仓消费者或生产smoke；
B6a记录的5项开发依赖公告仍待B7实际修复并重新audit，未以本轮测试声称消除。


## B7 执行分解与 B7a 运行时/测试工具链卡

2026-09-08；前轮分类为进展：B6b 2793882 已交付并在干净HEAD全门通过，289ad66记录验收。
本轮保持原Goal，不把测试能力当生产Prisma迁移；B7a先完成工具链，B7b严格typed lint、B7c AST架构、B7d纯格式依次交付。

| 项 | B7a决定 |
|---|---|
| Owner/writer | Billing，billing_owner唯一实现writer；Root设计/共享Git提交/最终验收，billing_ts_review只读版本与代码审查、billing_data_review只读规格审查 |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，289ad66c13d57707d261213a8e1e5ae0816121f1；开始干净；Root SQL手册/Agent/.tmp变更全部排除 |
| 目标 | Node24.20.0与同major类型包、本地/CI/镜像一致；Vitest5.0.0替代2.1.9；保留测试语义与真实PG/Redis覆盖；manifest精确pin已有解析，不同时改变业务依赖major |
| 放置比较/粒度 | `.node-version`放仓根供本地与CI读取，拒绝docs中的第二机器版本或并存.nvmrc；工具链治理用现有test/architecture/toolchain.test.ts，不放业务src或新建单文件目录；其余修改现有配置文件 |
| 允许写入 | .node-version、package.json、pnpm-lock.yaml、pnpm-workspace.yaml、Dockerfile、.github/workflows/ci.yml、.github/workflows/release-image.yml、test/architecture/toolchain.test.ts；确有Vitest配置兼容问题可修改vitest.config.ts；Root交接后更新文档 |
| 排除 | 所有生产src、SQL/contract/Prisma schema与生成配置、其他现有test文件、ESLint/TS严格配置、纯格式、其他仓与Git index；若新测试runner揭示用例需改，先报告具体文件/失败与语义 |
| 依赖/生命周期 | Node `/opt/homebrew/bin/node`实际24.20.0；bash前置PATH后运行pnpm11.25.0；Vitest原生可选依赖必须安装，release移除no-optional；不启用第二构建器或引入生产Vite；Prisma仍7.10.0及已批准scoped override |
| CI/API/数据 | CI与release verify读取.node-version，frozen install；release补SCHEMA_ADMIN_URL/catalog/Prisma生成检查，不改变生产协议/SQL/测试隔离；现有安全扫描阈值、签名/SBOM/发布顺序保留 |
| 删除 | Node22配置、浮动manifest范围、release no-optional；不保留第二Node版本源或旧test runner；不用兼容mock行为掩盖失败 |
| 验证/交付 | 先新治理测试RED（旧配置真实不符），再配置GREEN；frozen install、lint/typecheck/build/verify、真实integration、db:verify-schema/prisma:check、audit；性能记录耗时，不以新runner的默认行为冒充全部正确；Root提交后重跑完整门 |

依赖实际安装前核验精确稳定版本、Node/peer/license及镜像digest；版本只来自官方registry/发布文档，不从历史报告猜测。
Node Docker digest必须对官方manifest核验，查不到先保留明确未完成项，不伪造SHA。Docker本机不可用不妨碍native门，镜像实跑证据另列。
现有本仓没有vi.mock/vi.hoisted或poolOptions使用，Vitest5的默认clearMocks/top-level hoisting已读取官方迁移说明；仍须全测试实跑。
Root参考官方Vitest迁移与typescript-eslint typed-linting文档，工具语义不是Billing适配证明。


B7a安装前版本复核与Root裁决：Node24.20.0 LTS；@types/node24.13.3（MIT）；Vitest5.0.0（MIT，Node ^22.12 || ^24 || >=26）;
Vite8.2.2（MIT，Node ^20.19 || >=22.12），为Vitest5非optional peer（^6.4 || ^7 || ^8）。Root采纳**直接devDependency**精确pin Vite8.2.2，
因为这是测试runner真实强制peer控制，不是新生产bundler；避免浮动peer选择。Rolldown1.2.4 native bindings为optional，保留其安装。
Docker官方多架构index由只读`docker buildx imagetools inspect node:24.20.0-bookworm-slim`核验：
`sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`。
其他B7a工具仅pin实际lock：@eslint/js10.0.1、eslint10.9.1、typescript-eslint8.67.0、typescript5.9.3、tsx4.23.12、yaml2.9.0、@types/pg8.23.1。
候选后续typed工具：ESLint10.10.0、typescript-eslint8.70.0、兼容TypeScript6.0.3；registry最新TS7.0.2超过typescript-eslint的<6.1 peer，不采用不兼容最新。
Prettier3.9.6留B7d。以上为billing_ts_review只读核验，Root后续复核安装与digest，尚不声明升级完成。


B7a中途审查：工具链配置/精确版本/CI变化符合卡，Root frozen install与audit实际0漏洞；尚未整套验收。
规格review发现治理test只拼接命令字符串、JSON/YAML未收窄与配置漂移漏项；修订后Root发现负例baseline缺setup必然先失败，
再修订引入文件级no-explicit-any disable且manifest/lock反例仍缺。此处不以绿色测试数放行。
临时窄任务B7a-R：Root收回writer后交给billing_toolchain_hardening（gpt-6-astra），只允许test/architecture/toolchain.test.ts；
billing_owner已停止写入，仍为后续Billing实施负责人。hardening不改依赖/文档/生产/SQL/Git、不跑infra；Root负责提交，原两位reviewer独立复审。
目标为零any/零类型放宽、有效正向baseline、单因素因果反例、同一check函数验证manifest/lock/workflow/Docker；文件放置与B7a一致。

执行纪律补记：owner第一次完整verify的工具包装丢失session_id，观察30秒后误判终止并删除自身billing_owner_b7a_a19120d49101318a，
该次结果无效不计验收；只影响其自建库，未访问其他业务库。Root只读ps/PG确认无对应进程/连接、该库与billing_reference库当前均不存在。
后续保留完整exec结果并用session_id/write_stdin或cell_id/wait，不将观察超时视为执行终止。Root最终整套从独占新库重跑。


### B7a 独立审查与 Root 冻结工作树证据

配置实施billing_owner；治理test收尾billing_toolchain_hardening（gpt-6-astra），唯一writer先后交接，无同时写入。
数据/规格billing_data_review与TS/供应链billing_ts_review均已独立复审放行，无已报P1/P2遗留。
新测试344行，85项配置反例；不存在any/disable/非空断言，真实文件和正反例复用检查器，先正向再单因素失败并断言具体原因。
hardening实际旧实现RED为FROM静默漏检与YAML键序误拒2项；这不是生产业务回归数。

当前实际：Node24.20.0、pnpm11.25.0、@types/node24.13.3、Vitest5.0.0、Vite8.2.2，lock实际Rolldown1.2.7；
保留TS5.9.3/ESLint10.9.1/typescript-eslint8.67.0至B7b，所有direct精确pin，生产直接依赖解析版本逐项与fab7a00相同。
workspace engineStrict=true；Root以Node22.22.2执行frozen install实际exit1（ERR_PNPM_UNSUPPORTED_ENGINE），Node24同命令exit0。
两verify workflow均读取.node-version且真实frozen/apply/integration/catalog/Prisma/verify顺序；没有no-optional、if跳过或失败吞噬。
Root独立官方`docker buildx imagetools inspect node:24.20.0-bookworm-slim`成功核验批准index digest；本机docker info 8s超时，未启动/重启daemon。

| Root实际命令 / 资源 | 冻结代码结果 |
|---|---|
| `pnpm install --frozen-lockfile`（Node24） | exit0 |
| `pnpm audit --json` | exit0；info/low/moderate/high/critical均0，既有5项公告不再存在当前解析图 |
| 独占billing_accept_b7a_* `pnpm db:apply-schema` | exit0 |
| 同库/共享Redis DB4 `pnpm verify` | exit0；56文件318测试，0失败0跳过；85为新工具链配置测试，原业务测试仍保留；Vitest耗时31.07s |
| 同库 `pnpm test:integration` | exit0；32文件137测试，0失败0跳过；26.59s，包含于上行，不相加 |
| `pnpm db:verify-schema` / `pnpm prisma:check` | exit0；35表368列127约束83索引，catalog及生成0差异 |
| 独占billing_runtime_b7a_*，`node --import tsx src/main.ts`与`node dist/src/main.js` | 两者health/ready200、anonymous credit-account401、受信BFF commerce catalog200，SIGTERM退出0；随机端口与本轮库均清理 |
| `git diff --check` | exit0 |

Root日志：`/tmp/billing-b7a-root.lN5i5L`，摘要在本任务板持久保存。首次手工smoke探针把路径写为/v1/billing/me/account得到404，
这是probe错误；核对canonical路由后使用/v1/billing/me/credit-account与/v1/commerce/catalog完整重跑通过，不改生产路由掩盖问题。
规范化测试保持隔离和原默认进程隔离，不采纳Vitest输出的isolate:false速度建议。单次耗时不作为性能改进承诺。

新增维护风险：官方npm metadata确认prom-client15.1.3 deprecated，替代包@prometheus-io/client当前0.16.1/Apache-2.0，
本卡仅pin当前已验生产版本，不夹带metrics API替换；由B8/B10的metrics/lifecycle切片比较接口、许可证、故障和迁移测试。
Docker/PG16 CI/provider sandbox/镜像供应链运行仍未验；B7b typed lint、B7c AST边界、B7d格式、B8生产Nest/Prisma与B9/B10仍未完成。

本切片三文档门：
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md

上述三面仍一致于工具链变化、业务SQL/API不变；本轮contract:check/canonical catalog/Prisma check通过，不将此门扩为B8业务重写放行。
交付SHA和干净HEAD完整复验随后记录。


### B7a 交付与干净 HEAD 验收

交付SHA：`058bdf39b3dcbf7c084770670312b453a2a34354`。Root在该干净HEAD重新执行（日志`/tmp/billing-b7a-final.Dp5tr6`）：
- Node24.20.0/pnpm11.25.0 frozen install exit0；自有空库db:apply-schema exit0。
- `pnpm verify` exit0，56文件318测试通过（31.84s），0失败0跳过；lint/typecheck/build/sql/17-route contract全部通过。
- `pnpm test:integration` exit0，32文件137通过（27.47s），0失败0跳过；本集合包含在全套内。
- `pnpm db:verify-schema`为35表368列127约束83索引、0差异；`pnpm prisma:check` exit0无差异。
- `pnpm audit --json` exit0，全部严重度0漏洞。
- 当前构建之后再次分别启动源码与dist HTTP入口：health/ready200，anonymous credit-account401，受信BFF commerce catalog200；两进程SIGTERM正常退出0。
- `git diff --check` exit0，`git status --short`无输出；结束trap删除本轮独占database，未清空/重启共享PG/Redis或修改其他仓。

B7a配置/native交付已验收；镜像只有官方digest核验证据，本机daemon仍不可用，Docker构建/PG16 CI/provider sandbox未运行并保留B10验收项。
B7整体未完成：下一个可执行切片B7b（严格typed lint/兼容TS工具升级），再B7c架构、B7d独立纯格式；原Goal保持active。

### B7b 新的只读实际基线（尚未实施）

Root用当前Node24/ESLint工具在不修改配置、不生成产物的前提下，CLI临时启用全部手写TS的unsafe五规则及switch-exhaustiveness-check：
`pnpm exec eslint . --format json --rule @typescript-eslint/no-unsafe-argument:error --rule @typescript-eslint/no-unsafe-assignment:error --rule @typescript-eslint/no-unsafe-call:error --rule @typescript-eslint/no-unsafe-member-access:error --rule @typescript-eslint/no-unsafe-return:error --rule @typescript-eslint/switch-exhaustiveness-check:error`。
实际exit1：11文件49条（unsafe-member-access38、assignment10、argument1），不是当前既有lint门失败，不放宽目标规则。
集中于test HTTP JSON、几个integration matcher/result与scripts/schema-verification.error.ts的未知错误数组边界；新toolchain test未报unsafe问题。
临时报告`/tmp/billing-b7b-typed-baseline.json`，后续启用recommendedTypeChecked后还应重测完整规则，不以本49条当最终总数。
兼容升级候选仍为TS6.0.3 + typescript-eslint8.70.0 + ESLint10.10.0（实际安装前再核验）；TS7.0.2超过该lint peer上限，不盲追latest。
Root已读官方TS6发布说明与typescript-eslint dependency-versions，后续NodeNext、类型推断/defaults/build输出必须实际回归，不安装兼容双栈。


## B7b 严格类型切片执行卡

2026-09-08。前轮为进展：B7a058bdf3实现在干净HEAD通过318全套/137integration及源码/dist smoke，9eb06fc记录验收。
当前工作目录 /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，9eb06fc干净；其他仓及Root手册/.tmp排除。

| 项 | 决定 |
|---|---|
| Owner/writer/review | Billing；billing_toolchain_hardening（gpt-6-astra）负责B7b唯一写入，沿用已验加固负责人；原billing_owner不再活跃。Root设计/共享Git提交；billing_data_review规格、billing_ts_review代码只读 |
| 目标/当前事实 | 当前recommended只对src启unsafe；CLI完整recommendedTypeChecked+no-non-null基线56文件313条，详见下列文件；生产Fastify/pg未变 |
| 配置文件 | package.json/pnpm-lock.yaml、eslint.config.mjs、tsconfig.json/tsconfig.build.json（必要固定输出rootDir）、test/architecture/toolchain.test.ts（同步精确pins）；新test/architecture/typed-lint.test.ts验证实际ESLint运行正反例 |
| 目录/粒度 | 类型修复在原归属文件，不搬模块。typed lint测试放既有architecture而非生产scripts；多个test共享非空前置断言时允许单文件test/assert-defined.ts，不新建单文件fixtures目录；不把测试helper导入src |
| 依赖 | Node24.20.0/pnpm11.25.0/Vitest5/Vite8/Prisma7.10保持；升级TS6.0.3、typescript-eslint8.69.0、ESLint10.10.0，@eslint/js10.0.1保持；其他直接依赖不变 |
| 门禁 | recommendedTypeChecked覆盖全部手写src/scripts/test/root TS config；明确unsafe、Promise、no-non-null、switch穷尽；forceConsistentCasingInFileNames及noUncheckedSideEffectImports显式true；generated只按精确路径忽略lint，仍生成/typecheck/build，不手改生成物 |
| 行为/API/SQL | 普通输入/输出、数值、事务、错误原对象与falsey异常传播保持；不改SQL/API/权限/receipt/锁/状态。类型边界局部收窄，不生成另一wire契约；若发现必须改变业务语义先报告Root，不以重写旧pg逻辑夹带B8 |
| 删除 | src-only unsafe配置、非空/无用断言、重复preset规则；不引入any、双重断言、ts-ignore、eslint-disable、ignoreDeprecations或给对象强行String来掩盖未知输入 |
| 验证/交付 | 先实际typed lint正反例RED，再规则+修复GREEN；保留全部原业务断言，不能靠移走/skip测试、无意义await过门；Root独占库full verify/integration/catalog/Prisma/源码与dist smoke及audit，明确文件暂存提交 |

Root最终matrix：TS6.0.3（Apache-2.0、Node>=14.17）与typescript-eslint8.69.0（MIT，TS>=4.8.4<6.1、ESLint^8.57/^9/^10）互兼容；选择依据包括9月8日发布冷却门，详见下方裁决。
ESLint10.10.0、@eslint/js10.0.1（MIT）兼容Node24。registry TS latest7.0.2不满足lint peer，明确不选，不是退回更易过门版本。
TS6保持显式ES2022/NodeNext/types；rootDir默认变化须build确认dist/src与dist/scripts，显式side-effect import检查，不用弃用项消音。
Root采纳switch选项allowDefaultCaseForExhaustiveSwitch=true、considerDefaultExhaustiveForUnions=false、requireDefaultForNonUnion=false：
union即使有defensive default仍须逐成员穷尽，不机械要求普通string switch补default；这是显式项目选择，不降低已存在业务switch保障。

只读CLI/API基线（当前8.67 preset，升级后重新统计）：313条=non-null123、require-await119、no-base-to-string19、unsafe-member38、unsafe-assignment10、unsafe-argument1、only-throw-error1、prefer-promise-reject-errors1、no-unnecessary-type-assertion1。
报告/tmp/billing-b7b-full-typed-baseline.json。只读API override未写配置，不将此结果称已启用新门禁。
允许按该基线修复下列已有文件；新版本额外问题或新增helper/角色文件需向Root报告精确位置与理由再扩大：

- `prisma.config.ts`
- `scripts/canonical-reference.ts`
- `scripts/canonical-schema.ts`
- `scripts/prisma-artifacts.ts`
- `scripts/prisma-process.ts`
- `scripts/process-payment-events.ts`
- `scripts/schema-database-session.ts`
- `scripts/schema-verification.error.ts`
- `scripts/schema-verification.ts`
- `src/bootstrap/create-billing-runtime.ts`
- `src/infrastructure/auth/billing-auth.ts`
- `src/infrastructure/postgres/connection.ts`
- `src/infrastructure/postgres/repositories/credit/account-query-service.ts`
- `src/infrastructure/postgres/repositories/credit/redeem-service.ts`
- `src/infrastructure/postgres/repositories/metering/billing-admission-service.ts`
- `src/infrastructure/postgres/repositories/payment/provider-event-processor.ts`
- `src/infrastructure/postgres/repositories/reconcile/admin-stats-service.ts`
- `src/infrastructure/postgres/repositories/reconcile/reconciliation-service.ts`
- `src/interfaces/http/server.ts`
- `test/http/readiness.test.ts`
- `test/http/server.test.ts`
- `test/http/target-v1.test.ts`
- `test/integration/account-query.test.ts`
- `test/integration/admin-grant.test.ts`
- `test/integration/admin-stats.test.ts`
- `test/integration/admission-command-receipts.test.ts`
- `test/integration/catalog-admin.test.ts`
- `test/integration/catalog.test.ts`
- `test/integration/checkout-http-replay.test.ts`
- `test/integration/checkout.test.ts`
- `test/integration/durable-command-receipts.test.ts`
- `test/integration/durable-result-http.test.ts`
- `test/integration/grant-expiry.test.ts`
- `test/integration/mock-checkout-payment.test.ts`
- `test/integration/outbox-worker.test.ts`
- `test/integration/payment-fulfillment.test.ts`
- `test/integration/payment-reversal.test.ts`
- `test/integration/postgres-pool-context.test.ts`
- `test/integration/postgres-schema.test.ts`
- `test/integration/prisma-generation.test.ts`
- `test/integration/prisma-persistence.test.ts`
- `test/integration/provider-account.test.ts`
- `test/integration/provider-webhook.test.ts`
- `test/integration/reconciliation.test.ts`
- `test/integration/redeem.test.ts`
- `test/integration/redis-idempotency-hint.test.ts`
- `test/integration/redis-lease.test.ts`
- `test/integration/runtime-redis-loss.test.ts`
- `test/integration/schema-drift.test.ts`
- `test/integration/schema-installation.test.ts`
- `test/integration/subscription-query.test.ts`
- `test/integration/usage-pricing-admin.test.ts`
- `test/integration/usage-pricing.test.ts`
- `test/integration/usage-settlement.test.ts`
- `test/unit/redis-optional.test.ts`
- `test/unit/redis-timeout-policy.test.ts`


Worker不操作Git/文档/生产基础设施；构建/生成仅在已固定离线Client流程，不能refresh生成schema掩盖drift。
异步fixture优先Promise.resolve/reject明确表达契约；涉及抛错的stub要保留拒绝而非变为同步throw，不能插入无意义await只满足require-await。
unknown日志使用受控形状/安全消息；不得误删原始异常与Aggregate/cause或falsey rejection反例。
官方工具语义：TS6 release-notes、typescript-eslint users/configs与switch-exhaustiveness-check；版本与执行证据分开，最终兼容靠实际门禁。


### B7b 执行中裁决与冻结交接（2026-09-10续接）

前轮分类：进展。唯一writer已完成源码修复并交回PG窗口；最终报告前Agent因usage limit终止。
Root当次检查：旧exec20753句柄不存在，Agent状态errored，未发现Billing测试进程，专有billing_typed_b7b_*数据库无残留；
不把观察超时当终止，其他仓正在运行的Vitest保留不动。Root接管唯一writer及Git，按/tmp/billing-b7b-delivery-sha256.txt核对冻结文件。
交付仍为0ec3080后的未提交工作树，独立审查/Root完整验收尚待完成，不把旧日志直接充当新验收。

**版本裁决（发生于2026-09-08）**：8.70.0于2026-09-07T18:18:09.654Z发布，安装时不足pnpm11默认1440分钟。
第一次install自动添加11条minimumReleaseAgeExclude；Root未批准，writer恢复workspace基线字节。
随后真实pnpm preflight/frozen报ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION；没有配置age0、trustLockfile或任何豁免。
Root重新核验8.69.0（2026-08-31T17:08:46.355Z、MIT、相同TS<6.1/ESLint10 peer），选择当时最高已过冷却期的稳定兼容版本。
只恢复本轮未提交lock到HEAD，再按8.69 manifest正规安装成功；TS6.0.3/ESLint10.10.0及全部严格规则保持，不退回原8.67。
9月10日续接保留已冻结版本进行验收，不因时间流逝在验收中途重新解析浮动latest；下次升级重新核验。
来源：[pnpm11发布默认](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md)、
[发布冷却与锁验证语义](https://pnpm.io/settings/dependency-resolution)、
[8.70变更](https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.70.0)；版本时间/peer另经npm view实际核验。

Root已在实施前逐项批准的局部行为例外（不再笼统称所有输入行为不变）：
1. checkout persisted snapshot.creditMicros只接受string|number，再执行既有digits/safe-integer校验；其他形状报billing.checkout_quote_invalid，不发credit。
2. execution receipt.provider_operation_ref只接受string；null/undefined保持event fallback，其他形状报billing.execution_receipt_invalid，失败不能扣款或完成capture receipt。
3. HTTP webhook优先使用parseWebhook结果；只有缺省的eventId/eventType才校验raw fallback为string，null/undefined仍空ID/unknown；无效fallback报既有400 billing.provider_payload_invalid。已解析字段不因未使用的raw字段被误拒。
4. canonical installer用独立错误槽保存包括undefined/null/false/0/空串的原始异常，close错误不覆盖主错误；新增test/unit/canonical-schema-errors.test.ts单元故障注入。

以上新增授权测试只在已有HTTP/业务integration文件内；新增单元文件的owner为离线Schema安装错误/清理，不是数据库integration，未改installer公开API。
另新test/assert-defined.ts为多个测试共用的实际null/undefined前置检查，保留0/false/空串；生产不导入测试helper。
worker报告RED：HTTP原202而预期400两项；numeric-array quote原被String接受并发credit；receipt对象/数组/布尔/数字原全resolve四项；
installer undefined异常吞掉/null被close错误覆盖两项。日志仅是交付证据，Root独立验证后才放行。

**新增P0，B8/Metering负责人必须修复**：src/infrastructure/postgres/repositories/metering/usage-settlement-service.ts的ensureUsageEventForHold
生成hold:${UUID}共41字符，而database/schema.sql的entitlement_usage_event.usage_event_id为VARCHAR(36)。真实默认UUID路径报SQLSTATE22001。
B7b的receipt类型测试使用统一的合法短opaque hold fixture，仅隔离类型边界，并保留默认UUID失败与余额/hold/event/receipt回滚characterization；
这不是成功capture证据。B8必须换成满足canonical ID模型、tenant/幂等稳定的生成方案，并将该characterization替换成默认UUID真实成功/重放/并发断言；
不通过改宽字段、改短生产UUID、skip或保留只覆盖短ID的测试冒充完成。生产切换前此项未修即不放行。

| 审查任务 | 基线/范围 | 角色/交付 |
|---|---|---|
| B7b-R | 0ec3080+冻结源码hash；全typed配置、局部边界与错误、保留测试 | billing_data_review规格只读，Root提交/独占库完整验收；随后billing_ts_review代码复核 |
| B7c-R | 0ec3080+当时变化中B7b，只读AST调查 | billing_ts_review已交建议；Root尚未批准B7c实施，不改目标provider图 |

B7c只读事实：84手写src文件、215唯一source边，7组旧application Service↔ports纯type SCC，未解析/动态边0；
application跨业务feature无实际调用，仅依赖共享transaction port；实际跨领域编排仍位于legacy infrastructure。
因此application-only无环不能证明Credit唯一writer。B7c将保留tenant/SQL/auth门、替换禁modules/强制ports的机械门；
值/类型图分别建模，类型耦合如何随B8闭环由Root设计裁决，当前不宣称架构迁移完成。


### B7b 冻结工作树独立审查与Root验收（2026-09-10）

规格审查billing_data_review（Astra）与代码审查billing_ts_review（Sol）依次放行，无新增P1/P2；绑定
/tmp/billing-b7b-delivery-sha256.txt的64源码文件，Root前后hash核对完全一致。规格reviewer另运行真实ESLint全树exit0、
typed-lint/canonical-schema-errors/HTTP server三文件22项通过；代码reviewer独立检查错误槽、boxed result、artifact逆序回滚、async契约与SQL Row字段。
两者均未写文件/操作基础设施，Root统一验收，不将reviewer结论代替完整运行。

Root日志/tmp/billing-b7b-root.ovKWqD（以下都是本次新执行，不继承9月8日worker日志）：
- Node24.20.0/pnpm11.25.0，pnpm install --frozen-lockfile exit0（当前缓存环境，非冷缓存声明）。
- 自有billing_accept_b7b_<random>从template0安装canonical，pnpm db:apply-schema exit0。
- DATABASE_URL/SCHEMA_ADMIN_URL/REDIS_URL/**REDIS_TEST_URL**明确设置；pnpm verify exit0：58文件354项通过，0失败0跳过，34.99s。
  包括完整typed lint、TS6 typecheck/build、SQL门与17-route contract；dist/src及dist/scripts输出保持。
- pnpm test:integration exit0：32文件157项通过，0失败0跳过，28.68s；包含在全套内，不相加。
- pnpm db:verify-schema / pnpm prisma:check exit0：35表368列127约束83索引，catalog/生成均0差异；SQL与OpenAPI hash和基线相同。
- 源码node --import tsx src/main.ts和新构建node dist/src/main.js分别真实启动：health200、ready200、anonymous credit-account401、
  trusted-BFF commerce/catalog200、offers数组与request-id header/meta一致、SIGTERM退出0；随机本地端口，无provider外网调用。
- pnpm audit --json exit0：info/low/moderate/high/critical均0。所有生产直接包精确版本保持；Prisma Client锁的TS peer suffix随TS6改变，不宣称lock逐字不变。
- git diff --check exit0；trap在所有命令终态后正常删除本轮唯一数据库，未强制断开/重启/清空共享PG/Redis，其他仓进程未动。

354项相较B7a318项净增36：typed lint4、installer错误注入6、HTTP边界6、quote边界8、receipt边界7+UUID已知失败characterization1、falsey session扩展4。
明确：该UUID characterization通过是证明当前错误/回滚，不是生产capture成功；B8 P0依旧未解决。

Root首次探针需更正的证据亦保留/tmp/billing-b7b-root.Le58Cx：遗漏REDIS_TEST_URL导致350通过/4跳过、integration153通过/4跳过，
smoke把内部items误当wire字段而触发KeyError，真实wire为offers。该次不是全门通过；只修正Root临时probe/env，未改生产实现/测试门，
随后在全新独占库完整重跑得到上面0跳过结果，audit在首次probe失败后未执行、在重跑中真实执行。

B7b实现+对应测试+五份必要文档由Root按明确文件集提交；提交SHA与干净HEAD复验另记。B7c AST、B7d格式、B8 Nest/Prisma业务切换、
B9契约/消费者/外部副作用、B10可靠性/镜像仍未完成。未跑Docker/PG16 CI/provider sandbox/消费者验证，不扩大本切片放行范围。


### B7b 提交与干净HEAD最终验收

实现交付：`3fd97f56bee0c4aff8f0a095b9c9af164fc3e7fb`（69文件：64源码/配置/测试与5份文档）。
Root在该干净HEAD重新全跑，日志`/tmp/billing-b7b-final.7UxmBh`，exec9823正常终态exit0：
- frozen install、独占空库apply、pnpm verify全部exit0；58文件354测试，0失败0跳过，35.25s。
- 独立pnpm test:integration：32文件157测试，0失败0跳过，28.40s（全套子集）。
- catalog35表368列127约束83索引0差异；Prisma check0差异；SQL/17-route contract/typecheck/build皆在实际门内。
- 当前构建后再次源码及dist HTTP smoke：health/ready200、匿名401、受信BFF catalog200、offers与request-id断言、SIGTERM退出0。
- audit所有严重度0；git status干净、diff --check0；结束trap正常清理该次独占库，未操作他人服务/数据。

B7b仅此切片已验收；B7c/d、B8–B10及默认UUID capture P0仍未完成，Goal保持active。下一关键路径为B7c架构门设计与实施，
Root继续统一writer/provider/事务方案；不把typed lint通过等同于已迁移Nest/Prisma或已完成计费业务。


## B7c AST依赖门执行卡（2026-09-10）

基线541f373（实现3fd97f5已验354全套/157集成、0跳过），工作树干净。
工作目录/分支：/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing / codex/billing-ts-prisma-alignment。
前轮分类进展，B7b已验收；B7c只做真实工程边界门，不搬业务，不提前放行Nest/Prisma。

| 项 | 结论 |
|---|---|
| Owner/执行 | Billing，优先续派billing_toolchain_hardening（Astra）唯一writer；若实际仍因quota终止，Root明确交接给billing_ts_review（Sol），不得两个writer；Root管Git/文档/集成，billing_data_review只读规格审查 |
| 当前事实 | 84手写src、215唯一内部边，7组旧application纯type SCC；HTTP仅runWithBillingContext符号从PG connection导入，不能粗暴禁止后假装当前无该依赖；production Prisma尚禁用 |
| 目标职责 | TS AST+实际module resolver建立value/type/all三图，规则有稳定diagnostic（code/source/target/kind/location），真实项目与virtual fixtures共用核心；不按字符串禁词冒充依赖检查 |
| 目录比较 | 既有test/architecture vs scripts运行工具：采用test/architecture，只有测试门消费者，无新增运行CLI，不把编译器放production |
| 粒度/文件 | 新typescript-dependency.types.ts（共享图/诊断结构）、typescript-dependency-graph.ts（解析/解析路径/建图/SCC）、billing-dependency-policy.ts（唯一Billing边界与过渡债策略）、typescript-dependency-graph.test.ts（正反例）；修改ownership.test.ts和prisma-generation.test.ts接入同一核心。若真实project读取与纯图分析需分离，先报具体文件，不塞无关helper |
| 依赖 | 使用已安装TypeScript6.0.3及Node fs/path/module；package/lock不动，不建新包/CLI/空层；生产不得导入test；不改generated |
| 数据/API | canonical SQL/OpenAPI/业务源码/入口均不变；只替换机械目录规则，tenant JOIN/OFFSET、SQL、权限、契约、工具链和生成一致性门完整保留 |
| 删除 | 删除src/modules不存在与固定七repository ports存在断言；旧application/domain import regex以AST同等或更强检查替代；Prisma import regex改为同一AST解析。禁止migrations/db push等有效约束保留 |
| 验证 | TDD先各语法与规则真实RED/GREEN，原architecture及typed lint、lint/typecheck/build/unit/http；冻结后Root全套PG+Redis/Schema/Prisma/源码dist smoke；不靠虚拟目标正例声称真实生产已迁移 |

### 解析与图边界

使用TS6公共Compiler API与当前tsconfig真实options；内部`.js`导入解析到`.ts`，正反例与真实项目使用同一resolver管线（virtual host可替换filesystem）。
识别ImportDeclaration（type clause、specifier type、default、namespace、side-effect/空named import）、ExportDeclaration（export type/mixed/re-export）、
ImportEqualsDeclaration、ImportTypeNode/typeof import、字面量dynamic import/require。mixed语句分别记录type/value边，空named import不被every([])误判为type。
相对路径未解析、越出仓根、源语法错误、非字面量动态加载必须诊断；bare外部包与Node builtin明确分类，不能把internal alias误归external而放行。
真实项目扫描所有手写src，仅精确跳过src/generated/prisma/（生成物仍由原生成/类型/build门覆盖）；不按名称generic generated跳过任意业务目录。
非生产虚拟文件可直接在memory host，无需新fixtures树。保留路径大小写/realpath和仓界，禁止简单contains('infrastructure')判断路径。
只做静态可解析依赖约束，不宣称完整JS安全沙箱。生产当前无createRequire；明确拒绝node:module的createRequire（含别名），避免require别名变成不受控加载后门。
对普通被局部变量遮蔽的require不误判为真实loader，或明确受限语法策略并测试，不默默忽略疑似加载。

### 项目规则（当前态与目标态分开）

1. domain/application的值与类型边均不得指向infrastructure/interfaces；application不得直接依赖pg、@prisma/*或generated Prisma。
2. 旧interfaces不得导入PG数据库实现，**唯一有界当前例外**为server.ts从connection.ts具名import runWithBillingContext（允许local alias，但不得混入其他symbol/namespace/re-export/dynamic）。
   该例外不允许SQL能力；原SQL门保留。B8移动request/transaction context后删除此例外，不扩展目录级豁免。
3. Feature root为已选src/modules及当前src/application（排除明确shared ports）；跨feature值/类型只能走目标owner公开入口`<feature>.public.ts`。
   目标public entry用显式export，不机械export*；禁止公开re-export Repository/数据库实现。当前application无跨feature业务import；shared transaction/idempotency/safe-integer是精确既有能力，不泛放行ports。
4. 目标*.controller.ts不得直接依赖database/Prisma/Redis；Service→Controller拒绝。简单Service→同feature具名Repository允许；不强制有Repository/ports目录。
5. 全src value graph循环（含self-loop）全部拒绝；all/type图分别报告真实SCC。现有7组type-only循环允许的仅是541f373实际闭合边，作为具名B8债。
   在policy中按精确source-target type边登记，不给整个目录/节点任意循环豁免；新增/扩张边、变成value边、其他type循环均拒绝。
   不从当前受测源码自动生成expected来伪造门；有固定期望正反例。B8必须归零并删除过渡债，B7c只证明未新增和被识别，不冒称全type依赖无环。
6. production Prisma禁用仍保持至B8，检查真正的external @prisma及resolved generated路径；注释/普通字符串不算import，非字面量动态加载不能逃逸。

必须有单因素反例：value/type越层、alias/re-export/namespace绕行、跨feature deep import、controller→DB、service→controller、cycle/self-loop、
mixed type/value与空named import、合法type环识别但新增type环被拒、旧type债增边变值被拒、unresolved/path escape、syntax error、dynamic variable、
createRequire alias、`.js`→`.ts`正例；评论/普通字符串含Prisma/infra字样不误报；合法feature/public入口与本feature调用应通过同一checker。
Root会独立测试语法覆盖，不以测试数量或文件名称推断完整性。B8 Nest provider DAG/唯一writer/真实API消费者不在此门中假装验证。

### 交付与权限

writer允许上述6个文件，无其他写入。Root在handoff后停止写Billing；worker不能操作Git index/commit/branch、文档、SQL、contract、src、其他仓或共享服务。
可以只读git diff/show；多步骤测试必须保存完整exec session并持续poll到终态，观察超时不重启/清理。
Node24 PATH=/opt/homebrew/bin:$PATH、bash login=false；默认先无infra门，完整PG/Redis窗口由Root独占验收。
交付文件hash/实际RED与GREEN/命令/未完成风险，冻结后先规格、再质量审查，Root明确路径提交、干净HEAD重跑。
官方语义：[TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)（页面明确适用TS6及以前），
实际API以本地固定6.0.3声明和正反例为准，不更新编译器来迁就检查器。


## B8 前置复核与 B7c 执行中授权（2026-09-10）
Root 当前基线 00a5ad589ca1609ba14a16f238a540cfe2eef169。B7c唯一writer保持billing_toolchain_hardening；Root只读调查/自建PG探针，未并发改本仓。
已批准B7c第7文件 test/architecture/typescript-dependency-project.ts：真实tsconfig与src遍历I/O；纯图分析留原核心。补resolved但未扫描内部目标诊断、精确Prisma生成例外、TS源扩展扫描、静态template及dynamic import options正反例；无新依赖/生产修改。

Root 两个新的真实缺陷证据（SQL/src均为基线，独占template0临时库安装当前canonical，命令终态后正常删除，查询无billing_probe_b8_*残留）：
- pricing P1：/tmp/billing-b8-pricing.2S2ZlZ。通过真实createPostgresUsagePricingAdminService和两个真实connection运行同tenant不同idempotency key发布，仅在各自实际MAX查询返回后设置调度barrier。两者都读revision0，1个提交revision1、另一个SQLSTATE23505/uq_entitlement_usage_price_revision_site_number；失败者pricing/receipt全部回滚。不是mock数据库结果，也不是并发功能通过。B8必须在同tenant命名空间锁内分配修订号，最终验收两个合法发布均成功且不同revision，保留UNIQUE，不把冲突包装成功。
- outbox P1：/tmp/billing-b8-outbox.gVLehA，exec47603 exit0。真实payment_outbox JSONB数组[]，worker maxAttempts=1/leaseSeconds=1；parsePersistedJson在try外直接抛billing.outbox_payload_invalid。等实际lease到期后再取，attempts从1升2，dead_lettered_at/published_at保持NULL，handler未执行，lease仍持有。当前poison测试只覆盖handler抛错。B8/B10必须把decode失败纳入同一有限重试/死信状态机，不能放宽parser；该结果只证明缺陷，不是可靠性验收。

B9发布/消费者复核：远端origin=https://github.com/LordFoxFairy/kokoro-billing.git；gh api实际返回releases=[]、tags=[]、actions/artifacts.total_count=0。仅证明该GitHub仓当次可见发布记录，不能推出不存在仓外部署。BFF src/http/routes/owner.ts实际手写调用catalog与checkout；Web走BFF；当前Agent src仅billing注释、Scheduler billing.reconcile仅测试样例，不能把这些当活跃Billing客户端。UUID资源输入及breaking门由只读B2复核后Root裁决，尚未原位改v1。

B2只读复核另证实：当前HTTP测试接受offer-revision-1、adm-1、settlement-1；settlement_id同时作为caller选定主键、receipt identity与响应。将这些输入直接改UUID会破坏现有v1，不是纯数据库重命名。B9-design的ID分类、生成权、digest/replay、refund定位和版本/消费者策略必须前置于B8生产SQL/业务重写；B9消费者实施仍在owner新契约交付后。已向用户异步询问线上数据/仓外调用方状态；B7c/B7d等独立工作继续，不据GitHub空发布推断答案。

### B7c 首轮规格审查（冻结未提交源码）

billing_data_review核对七文件hash一致、实际70项通过，但发现P2：public转导出经bridge别名暴露Repository会漏报。
Root独立用同一analyzeDependencies/checkBillingDependencies实跑：orders.repository导出OrdersRepository，bridge转为Store，
orders.public再导出Store，跨feature导入Store；所有边可解析而diagnostics=[]。因此首轮不放行，不先做完整验收来掩盖规格缺口。
修复限静态具名export lineage（含别名/中间barrel及import后local export）；不追任意JS数据流，不以所有可达依赖均禁用误伤
合法public Service内部使用Repository。实现负责人续派同一七文件集，Root停写直到再冻结；规格复审后再质量审查。


## B7d 格式治理设计卡（2026-09-10；B7c验收后执行）

Owner：Billing，Root负责设计/Git/最终验收；billing_toolchain_hardening优先续任唯一writer，独立规格/质量审查。
基线：当前62c2bfb+冻结B7c代码；实施前填写B7c已验收commit与实际clean状态，不在变化中的B7c上开始格式化。
现状：缺少format:check/Prettier直接依赖/仓内配置；手写文件存在单双引号及紧凑布局混用；SQL和OpenAPI字节已有独立authority。

| 放置项 | 裁决 |
|---|---|
| 目标职责 | 统一可重复的手写源码/测试/工程配置格式，CI强制检查；不承担语义lint或业务重构 |
| 位置比较 | 仓根Prettier配置 vs 全局/editor隐式配置：采用仓根配置及精确本地依赖，开发与CI一致；不引入新业务目录/脚手架 |
| 文件粒度 | 新.prettierrc.json与.prettierignore；package.json/lock增加本地formatter及format/format:check；既有verify前置format:check；test/architecture/formatting.test.ts证明配置范围/正反例 |
| 依赖 | devDependency prettier=3.9.6；Node24/pnpm11/TS6及生产包保持，禁止浮动npx/dlx/全局formatter；现eslint无格式规则，不为凑配置引入额外lint插件 |
| 覆盖 | src、test、scripts支持的源码及仓根TS/MJS/JSON/YAML、.github工作流；明确正向glob，SQL/机器OpenAPI/Markdown不夹带重排 |
| 排除 | 精确src/generated/prisma、database/generated只读产物，node_modules/dist/coverage和pnpm-lock.yaml由各自工具治理；不以通用generated目录名忽略其他手写源码 |
| 数据/API | canonical SQL/OpenAPI/生成schema/provenance字节保持；不更改API资源、错误、事务、配置语义和模块边界 |
| 删除 | 不保留第二formatter或临时prettier-ignore来隐藏手写失败；不引入空目录/alias |
| 验证 | 固定版本/config解析、实际合法格式正例/未格式化反例、精确ignore对照；格式后重复运行幂等；Root对每个纯格式文件验证new==prettier.format(old,config)，完整lint/typecheck/test/build/SQL/contract/catalog/Prisma/源码dist smoke |

2026-09-10实际npm view核验：prettier latest=3.9.6（2026-07-21T05:51:53.987Z，MIT，Node>=14）；next=4.0.0-alpha.13不采用。
System/IAM当前也固定3.9.6，仅作仓内一致性参考，不将它们旧验收替代Billing实际门。
工具语义：[本地精确安装与check](https://prettier.io/docs/install)、[ignore范围](https://prettier.io/docs/ignore)。
.prettierrc.json采用空对象固定Prettier标准默认值，避免额外样式争论；默认双引号/分号与近期已格式化治理文件一致。

写入范围：上述新配置/测试、package/lock，以及格式化覆盖内已跟踪文件的机械变更；不动其他仓、SQL、contract、生成物、文档或Git。
Root交接后更新文档。若格式化暴露旧文本型测试脆弱断言，先报告具体规则和单因素反例，单独批准等价修复；不得改生产语义或降低门禁。
不得一边改文件一边让reviewer声称最终验收；全部冻结后提交hash/文件集/实际命令，Root接管并逐文件审查后按明确路径提交。


## B7c 双审与Root冻结树完整验收（2026-09-10）

实现commit：8fbf8e0d6894a8067ab28021bb6242e1aec0315a；七文件由Root明确路径暂存/提交，依赖、SQL、OpenAPI、src无变更。
首轮P2已修：8项lineage反例真实RED后最终80定向全通过。Root独立重复原两段Repository转导出反例命中public-persistence，
仅选择同barrel的Service导出且其内部使用Repository仍返回0诊断。数据reviewer R2实际80项通过并放行，Sol质量审查3文件92项通过/476ms、无P1/P2。
各方绑定/tmp/billing-b7c-lineage-delivery-sha256.txt；Root提交前再次核对7文件全一致，不以读审报告替代运行。

Root连续验收session50298正常exit0，日志/tmp/billing-b7c-root.EseBig：
- Node24.20.0/pnpm11.25.0，pnpm install --frozen-lockfile exit0；本机PG18.4/Redis既有实例，自建template0独占billing_accept_b7c_972834163b02496a91c6。
- pnpm db:apply-schema exit0；DATABASE_URL/SCHEMA_ADMIN_URL/REDIS_URL/REDIS_TEST_URL均显式设置。
- pnpm verify exit0，59文件433项通过、0失败0跳过，36.70s；包括全typed lint、TS6 typecheck/build、SQL及17route contract。
- pnpm test:integration exit0，32文件157项通过、0失败0跳过，28.95s（全套子集，不相加）。
- pnpm db:verify-schema exit0：35表368列127约束83索引，0差异；pnpm prisma:check exit0，无生成漂移。
- 源码与当次dist分别实际启动：health200、ready200、anonymous credit-account401、trusted-BFF catalog200、offers数组及request-id一致、SIGTERM exit0。
- pnpm audit --json exit0，五级漏洞皆0；git diff --check exit0；SQL/OpenAPI SHA256保持57b6ff.../58fbe4...原完整基线。
- 所有子进程終态后正常drop本轮独占database；无FORCE/drop他人库/清共享Redis/重启共享服务。PG16 CI、Docker/provider sandbox/消费者未执行，不扩大放行。

图事实保持84手写src、215唯一内部依赖、304分kind/语法边、value SCC0、type/all各7组、39条有界旧type边；export来源绑定单独存储，不制造假运行边。
433相较B7b354净增79：80图/策略正反例，删除1条机械ports存在断言；其余有效门保留。
本切片仍保留B8精确HTTPcontext与type债，不声称Nest、Credit唯一writer或业务Prisma已经切换；B7d/B8/B9/B10及UUID capture等P0仍未完成。
当前冻结代码全门通过，相关文档更新后还会在干净HEAD复验；下方/后续记录该结果，不把本段提前称作干净HEAD验收。
