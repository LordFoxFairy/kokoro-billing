# Billing TypeScript / Prisma 规范化任务板

日期：2026-09-08。唯一任务板；总范围是 Billing 工程收敛，不把第一轮审计视为整仓完成。

**Goal:** 按 Root TypeScript / SQL / API 手册明确 Billing 的模块、Prisma 数据访问、事务与契约方案，逐切片替换并验证。

**Architecture:** Billing 继续作为账务唯一 owner；按业务能力聚合 Nest module/provider，PostgreSQL 保持 durable authority，Redis 仅优化。Prisma 的 schema/锁/约束承接须经证据评审，禁止只安装依赖或保留双写就宣称完成。

**Tech Stack:** 当前 Fastify + pg + Zod 3；目标 Nest 12 + Prisma 7.10.0、SQL-first只读生成链，见ADR-0003；尚未安装目标栈。

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
| B5 / P0 / 全量catalog drift | Billing / 后续续派billing_owner / Root | 安装/验证scripts、integration、生成治理文档；派前冻结精确文件集 | 比较canonical参照库的35表全部列/约束/索引/predicate；缺CHECK与错predicate反例 | 待派工；依赖B4 |
| B6 / P0 / Prisma承接验证 | Billing / 后续续派billing_owner / Root | 固定依赖/生成链/模型/数据生命周期/独立验证；派前冻结文件集 | stable版本、无第二schema、typedCRUD+同tx锁/receipt/outbox+BigInt+错误+生成drift；不切生产writer | 待派工；依赖B5 |
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
