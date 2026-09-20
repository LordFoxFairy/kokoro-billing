# Billing TypeScript / Prisma 规范化任务板

更新：2026-09-12（技术方案收敛与连续实施准备）。唯一任务板；总范围是 Billing 工程收敛，不把第一轮审计视为整仓完成。

**Goal:** 按 Root TypeScript / SQL / API 手册明确 Billing 的模块、Prisma 数据访问、事务与契约方案，逐切片替换并验证。

**Architecture:** Billing 继续作为账务唯一 owner；按业务能力聚合 Nest module/provider，PostgreSQL 保持 durable authority，Redis 仅优化。Prisma 的 schema/锁/约束承接须经证据评审，禁止只安装依赖或保留双写就宣称完成。

**Tech Stack:** 当前 Fastify + pg + Zod 3；目标 Nest 12 + Prisma 7.10.0、SQL-first只读生成链，见ADR-0003；B6a已安装Prisma生成链；生产仍Fastify/pg，Nest与业务writer未切换。

## B8-M3 业务切换放行卡（2026-09-13，Root 收敛实施边界）

| 项 | 本轮边界 |
|---|---|
| 目标/P0 | 在已验32表/Prisma/一致性组件上落实七feature完整业务writer及Nest运行切换；删除旧pg业务与全局四层，不以平行未接线模块作为最终交付 |
| 基线 | Billing `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，codex/billing-ts-prisma-alignment，`938bd46fa7a0660d783ab39dcfe509f75345eaad`，Root本卡前clean；M2b最终325项与19探针已验 |
| 当前事实 | 主进程仍bootstrap→Fastify interfaces→application ports→pg repositories；Payment/Refund/Metering旧writer均直接写Credit表；canonical已32表而旧表已删除，135项历史旧业务失败尚待迁移 |
| 放置/粒度 | 按TECH D1采用src/modules七feature公开面+具名service/repository；继续旧全局四层或新增旁路SDK淘汰。复用本任务板与三设计，不新建第二任务中心；具体切片由Root核定后续派 |
| 角色 | Root负责整体顺序/事务组/旧路径删除/共享入口与Git；billing_transaction_m2a只读盘点Credit/Metering跨表writer及测试承接，输出后再续派写入；billing_model_r2按Root完成的切片门只读审查 |
| 本轮只读范围 | src/application/{credit,metering}、对应pg repositories以及Payment/Refund对Credit的直接写入、相关tests/scripts调用；无源码/Schema/contract修改，无PG/Redis/进程操作，Git由Root |
| 已确定依赖 | 继承三设计D1/R2/R3/M1b/M2b，Credit不依赖Metering/Payment；Metering→Credit；Payment核心不依赖provider-events编排；网络均在业务事务外，当前组件不与旧pg拼接事务 |
| 交付/验证 | 先给实际文件/方法/完整事务写表/调用方/测试迁移清单，Root据此固定业务切片边界并更新三设计当前态。所有代码写入必须等明确切片卡；无新owner/协议裁决不重复询问用户 |

### M3 实施卡（2026-09-13，设计门通过，C1 准备实施）

| 项 | 授权与完成条件 |
|---|---|
| ID/优先级 | B8-M3/P0：完整七业务模块、真实 Nest HTTP/worker/seed，替换并删除旧四层/pg 业务路径；内部检查点不是可部署完成状态 |
| 基线 | `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，`codex/billing-ts-prisma-alignment`，`19195a13775123d666a586c90fc649116328880c`；Root本卡前clean，随后三设计/本卡修改仅属Root |
| 角色 | billing_transaction_m2a 为唯一源码/测试/必要文档 writer，沿用既有负责人/模型；billing_model_r2 独立只读规格/质量审查；Root总体设计、边界裁决、Git/index/最终验证。本卡复核通过并由Root明确续派后写入 |
| 三设计 | TECHNICAL_DESIGN/API_CONTRACT/DATA_MODEL 顶部 M3 与既定 D1/R2/R3/D2/D3；只读盘点已完成11组writer，拒绝Credit单独接线形成混合事务 |
| 允许集 | 本仓 src 七modules与框架支持、原四层/bootstrap/main/config/database 必要承接和删除；scripts worker/seed/契约生成与校验/验证入口；test 对应unit/integration/contract/architecture/smoke/fixtures；package/lock/workspace/tsconfig/eslint/prettier/CI/Docker仅此运行切换必要项；src/generated/billing-api只读正规生成；README/INDEX/AGENTS/contract README/docs当前设计/任务板/验收/运行文档 |
| 冻结/排除 | 不改其他仓与Root；SQL canonical32及generated Prisma schema/provenance、v2 YAML已验字节冻结，需变更先报Root；不操作Git/index/分支、不重置共享资源、不发布远程、不批量无关格式化/升级 |
| 依赖 | Database既有组件→Credit+Paymentcore→Metering/Checkout→Refund/Subscription→PaymentEvents/Reconciliation→HTTP/worker；七feature严格DAG，公开面不含repository/Prisma，网络事务外；具体锁/两阶段见三设计 |
| 新工具 | @nestjs/platform-fastify12.0.1、ajv8.20.0、ajv-formats3.0.1 runtime；@hey-api/openapi-ts0.99.0 dev TypeScript-only；YAML纯JSON schema导出。openapi-typescript7.13.0 TS5 peer不兼容淘汰。安装后必须验证精确lock/peer/frozen/audit/生成compile/runtime |
| C1检查点 | Credit核心与Metering同事务组真实实现/测试（含redeem/admin/subscription-payment fulfillment effect、退款effect、expiry），初次可冻结定向验证供Root审查；保持完整M3任务持续，不宣称独立模块壳完成，不提前将其与旧pg连接 |
| C2检查点 | Payment/Checkout/Refund/Subscription+PaymentEvents承接全部owner writer/外部网络恢复，Reconciliation只读快照；Credit消费者不直接写Credit模型，实际并发/尾部回滚/可信证据与重复效果测试 |
| C3检查点 | 真Nest v2 HTTP24op、worker和seed全接线，删除旧四层/factory/v1，源码/dist运行、worker drain/lease/unknown recovery、全部旧有效行为承接；无永久双轨。仅这里整体运行cutover后可请求整仓验收 |
| 验证 | pnpm format:check/lint/typecheck/build/sql:check/contract:check；新增contract:generate与contract生成drift；prisma:check、fresh/catalog32；DATABASE_URL/SCHEMA_ADMIN_URL/REDIS_TEST_URL显式自有隔离资源，pnpm test和test:integration零静默skip；source/dist24op与worker恢复、最后attempt、跨tenant、Redis loss、深层回滚；frozen install/audit |
| 风险/后续 | subscription付款资格policy用户确认中；其他链路继续实现，不以policy未激活冒称订阅全完成。跨仓consumer/M4剩余恢复与真实provider sandbox/镜像/完整发布门仍属Goal，M3不删范围 |
| 交付 | 每检查点停写交绝对文件集/实际日志/风险；Root核范围、独立审查及主树重跑再串行自洽commit，随后续派同writer。最终交付SHA和通过/失败/跳过数量回填本表 |

M3 文档门：billing_model_r2 只读复核 `19195a1` + Root 四文档 diff，无 P1；唯一 P2“每个账务组是否必须 emit”已明确为仅 R3 受控有 receiver 的任务，删除无 receiver 纯通知，不扩展 registry。三份入口为 `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md`、`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md`、`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md`。Root 当前实际 `pnpm contract:check` 旧17/目标24、`pnpm sql:check` 通过，SQL/v2 SHA 与上卡冻结一致；未重跑未变化的32表集成，前次 M2b 实测证据仍绑定938bd46。订阅policy待用户商业确认，不阻断C1事务effect和其他模块；没有其他C1前置未决。C1完成后停写审查，后续同writer续派C2/C3，完整Goal不缩小。

### M3-C1 内部基础切片（待 Root 验收）

- 先收敛单一全局 `DatabaseModule.register` 根装配和静态 Credit/Metering module，再扩展其余能力；业务 module 不接收数据库配置、不转导基础设施。
- 当前基础实现覆盖 owner 计算 command digest、永久 receipt 重放、grant/reserve/capture/release、同事务 audit、按次 quote、usage settlement 与完整 usage identity 校验，以及生效/到期窗口投影。真实 PostgreSQL 定向测试覆盖并发余额竞争、capture/release 竞争、跨 feature 同事务、未来生效、到期、漂移和尾部失败回滚。
- 本切片交付后仍未完成的 C1 能力为 redeem/admin、批量 grant/hold expiry、Payment/Subscription fulfillment、Refund reversal、pricing publish 与 admission 完整资源编排；这些继续属于 C1，未移出 M3，也不表示旧运行时或 Billing 可部署。

## B8-M2b 执行卡（2026-09-13，设计已复核，组件实施中）

| 项 | 决定 |
|---|---|
| 目标/P0 | 完成Nest/Prisma生命周期、root只读/worker根事务、正规化receipt/key绑定、AuditAppender与fenced Outbox持久组件；为M3/M4完整writer切换提供真实可用基础 |
| 基线 | `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，codex/billing-ts-prisma-alignment，47b676f8c77ef3e31af0a69de2c48e1756d8ecd8，Root本卡/三设计前clean；M1b目标contract204测试已验 |
| Owner/角色 | Root设计、审查、Git/index、主树集成验证；billing_transaction_m2a下一阶段唯一writer；billing_model_r2只读设计/终审；iam_billing_authorization已交只读writer定位及key2/id2缺口 |
| 放置与粒度 | 复用src/database；比较业务modules/common及独立新模块均淘汰，这是有明确3表+key绑定的持久支持，不是业务owner。数据库生命周期/事务/三个具名writer按变化原因分文件，不建BaseRepository或空层 |
| 允许文件集 | src/database现有transaction三个文件；新增prisma.service.ts/prisma.types.ts/database.module.ts、command-receipt.repository.ts/command-receipt.types.ts/command-receipt.error.ts、outbox.repository.ts/outbox.types.ts/outbox.error.ts、audit-appender.ts/audit.types.ts；需要的具名持久JSON codec仅限该目录，不复制旧层。database/schema.sql及正规生成schema/provenance；package.json/pnpm-lock.yaml/pnpm-workspace.yaml/tsconfig*.json只限本切片必要依赖与编译；相关test/unit与test/integration的transaction/receipt/outbox/audit/prisma-lifecycle/schema/Prisma fixture；test/architecture依赖与新writer门；INDEX/CURRENT/本卡/三设计/ADR0003的当前证据 |
| 排除 | src/application/domain/infrastructure/interfaces/bootstrap/main以及旧worker/seed本轮不接新实现；不改v1/v2字节/HTTP/其他仓；不批量格式化、不改无关依赖、不删失败测试/兼容旧表 |
| 数据与依赖 | M2b三设计明确31→32表key binding正规化，保留同identity换key重放且每key永久绑定；SQL唯一source、无FK。Nest12.0.1 core/common/testing+reflect0.2.2/rxjs7.8.2精确固定，暂不安装HTTP adapter；registry证据见TECHNICAL_DESIGN。业务API不暴露ORM/Repository，内部database角色可用本仓generated类型 |
| 删除 | 删除receipt单值key列/旧唯一约束，不保留双可编辑key来源；目标组件不启用旧pg双轨。旧运行时在M3/M4一次切换后删除，当前中间组件不发布 |
| 验证 | 先真实RED：key1/id1→key2/id1→key2/id2最后必须409且效果仍一份；多client并发key/identity、不同digest、两域交叉、损坏结果、跨tenant/actor/关闭上下文、业务+receipt+binding+audit+outbox深层回滚、租约过期/旧token晚写；root read mutation拒绝；Nest真实生命周期源码/dist。复用fixture自建PG；不reset或启动共享服务 |
| 命令 | pnpm format:check/lint/typecheck/build/sql:check/contract:check；prisma:refresh→prisma:check；schema fresh/catalog32；pnpm exec vitest run test/unit/transaction.test.ts test/integration/transaction.test.ts test/integration/command-receipt.test.ts test/integration/outbox.test.ts test/integration/audit-appender.test.ts test/integration/prisma-lifecycle.test.ts test/architecture --no-file-parallelism（新增文件在实现前不假称存在）；pnpm install --frozen-lockfile及pnpm audit。原135业务失败保留，不放宽门禁 |
| 阶段/交付 | 设计复核后单writer实施，允许先提交依赖/生命周期与后提交receipt/outbox的自洽切片，但共享index仅Root。writer停写交文件/hash/命令/资源；Root重跑并独立审查后提交。最后attempt恢复、worker loop/drain、业务owner/NestHTTP/消费者仍属M3/M4/M5 |

M2b文档门通过：billing_model_r2只读复核key-binding、两域一致性、事务/根查询与worker边界，无剩余设计P1/P2。三设计绝对路径：`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md`、`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md`、`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md`。设计审查基线`47b676f`+本卡/三设计，当前Schema仍31表；32表fresh/catalog/Prisma的实现验证待本卡writer交付，不冒称已通过。M1b committed HEAD的`pnpm contract:check`及8文件204项复验通过；一次误在Root执行Vitest的命令因无该依赖退出，切回Billing后完成复验。M2b仅组件门，无新业务owner/外部API未决，不阻断实施；线上运行、worker与消费者验收另属连续全目标。

### M2b 持久一致性续派卡（2026-09-13）

| 项 | 续派边界 |
|---|---|
| 已验收/新基线 | 生命周期提交 `ccd617a3d3ecfc95c6563879feceac8ed1eb2519`，Billing 独立仓 codex/billing-ts-prisma-alignment；Root 本卡更新前 clean。不是整仓通过 |
| Owner | billing_transaction_m2a 继续唯一 writer；Root 管理 Git/index、终审和主树验证；billing_model_r2 持久性只读审查按交付后续派 |
| 目标 | 同一 Prisma 事务中的正规化 receipt/key binding、AuditAppender、fenced Outbox；canonical 31→32 与只读生成同步，不再重做生命周期切片 |
| 文件集 | 继承本节总卡允许集；重点 command-receipt/audit/outbox 具名组件、DatabaseModule 注册、必要 transaction scope accessor、SQL/generated、对应 unit/integration/architecture/文档；不修改旧 runtime/HTTP/其他仓，不操作 Git/index |
| 完成条件 | 已批准 key1/id1→key2/id1→key2/id2 冲突及单份效果；并发/两域交叉/损坏结果/跨 scope 拒绝；receipt+binding+业务+audit+outbox 原子回滚；Outbox claim/renew/late-write fencing/重试与 requeue；32 表 fresh/catalog/prisma 同步，原门禁不削弱 |
| 验证/资源 | 先测试实际 RED 后实现，复用实例、自建 UUID 临时数据库；一次只有该 writer 操作测试库，Root 等冻结后串行验收。新测试真实依赖显式 SCHEMA_ADMIN_URL，禁止默认开发者凭据或静默造绿 |
| 交付 | 代码/测试/schema/必要文档自洽后停写，报实际文件/hash/日志/剩余风险；共享提交由 Root 完成。worker loop/drain/最后 attempt 恢复、HTTP/业务组仍属 M3/M4，不从总目标删除 |

### M2b 持久一致性：Root 集成验收（2026-09-13）

- 基线 `63732b55ceb39001a29ab5f9e9b198a82c3fab38`，billing_transaction_m2a 为唯一实现者，Root 接收冻结文件、独立验证并负责提交。当前 32 表已实际 fresh install/完整 catalog 验证；SQL SHA256 `b8dd35be1137432742e3a250b3c95b406d5c993bd850f67ab720e21007cba521`，generated schema `eabf3ab6fae504ac94e874941237cae4c8bec1134dcf0b6025ce47bee1361595`，provenance `0260305a6f581a66095f3cea741c5f7ffbbed093c7901b92adebffc39a5590c1`。没有第二份可编辑 Schema 或旧 key 列。
- 永久 receipt/key binding 由同一个具名组件维护。`execute` 仅包裹当前业务事务的 claim/replay/complete，不开启根事务或引入通用 command bus；嵌套 run 保留 effect/codec 故障的 rollback-only。AuditAppender 从可信 scope 取 actor。Outbox 仅注册已确定的三种 payment effect，根 worker 调用方负责 runRoot；没有提前启用旧 worker 双消费。
- Root 首次冻结验收 324 项通过后，独立审查仍发现跨 scope binding 与合法 identity 并存时误分类为409。Root 真实 RED `/tmp/billing-m2b-root-scope-corruption-red.log` 复现，修复为先校验 keyed scope，再比较两域身份；正式组合回归与同一独立探针均通过。billing_model_r2 最终只读审查无剩余本切片 P1/P2。
- 最终冻结树：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm sql:check && pnpm contract:check && pnpm prisma:check` 全通过。Root 真实定向命令 `pnpm exec vitest run test/integration/{command-receipt,outbox,audit-appender,prisma-lifecycle,target-schema,prisma-generation,prisma-persistence,transaction,schema-drift,schema-installation,postgres-schema}.test.ts test/unit/{transaction,persisted-json}.test.ts test/architecture test/contract --no-file-parallelism --reporter=verbose`，**21 文件 325 项通过、0 失败、0 跳过**。独占目标 database 通过 withCanonicalReference 安装，显式 DATABASE_URL 与 SCHEMA_ADMIN_URL，资源已清理；日志 `/tmp/billing-m2-root-focused.log`。
- Root 另跑独立 receipt 11 项、Outbox/audit 8 项全部通过：两个 Prisma Client 并发、永久换 key 绑定、两域冲突、损坏结果、跨 tenant、外层吞错后整组回滚、五类事实同提交，以及 renew/complete/retry/deadLetter 在行锁等待后租约过期均拒绝。Root JSON RED 4 项原静默变形输入在严格边界后全部拒绝；对应正式 unit 测试保留旧 parser 断言。日志 `/tmp/billing-m2b-root-persistence-final.log`、`/tmp/billing-m2b-root-json-red.log`、`/tmp/billing-m2b-root-json-green.log`。
- 源码 tsx / 构建后 node 的真实 NestFactory 数据库 context 均通过写/读/生命周期/关闭后 callback 零调用 smoke。冻结依赖未改变；本轮 Root `pnpm install --frozen-lockfile`、`pnpm audit --prod`、`pnpm audit` 均通过，未发现已知漏洞（`/tmp/billing-m2b-root-persistence-gates.log`）。这些都不是 Billing HTTP、支付 sandbox 或镜像验收。
- 当前仍是不可部署中间态：旧 Fastify/pg 与旧 HTTP 未切，最近完整旧业务结果仍为 M1 的135失败，未假称本轮重跑全量；下一步为七模块完整 writer/事务组替换、删除旧路径，再交付 HTTP/worker/消费者与完整运行验收。全部原目标保留。

### M2b 生命周期 R1：Root 集成验收（2026-09-13）

- 基线 `a98dfdf349118f512dbeff5473b50db9cbd03961`，负责人 billing_transaction_m2a 冻结交接 13 个源码/依赖/测试文件；Root 独立复验并串行提交，未接入旧业务 runtime。此提交仅完成本卡生命周期/root API 子切片，receipt/key binding、audit、outbox 仍待同负责人继续实施。
- 新增 DatabaseModule/PrismaService：精确 Nest 12.0.1 依赖、一个 Prisma adapter pool、共享初始化/清理 Promise、单调 ready/closing/closed 状态。注入的 TransactionService 每次根入口/查询检查生命周期；readRoot 仅暴露只读 model 能力，拒绝 mutation/raw、逃逸 client、异步借用及事务内 root 查询；runRoot 保留事务 ALS 边界。
- Root 首轮常规 235 项通过仍发现两个真实缺陷：readRoot callback 进入事务后 captured root client 可误读 root pool；初始化失败后 destroy 重复 pool.end。独立 RED 日志 `/tmp/billing-m2b-root-lifecycle-red.log`；R1 同一探针零失败，初始化错误由 init 调用者持有，后续重复 destroy 成功。日志 `/tmp/billing-m2b-root-r1-probes.log`。
- Root 冻结树执行 `pnpm install --frozen-lockfile`、`pnpm audit --prod`、`pnpm audit`（均未发现已知漏洞），以及 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm sql:check && pnpm contract:check` 全通过。真实测试命令：`SCHEMA_ADMIN_URL=<同实例管理连接> pnpm exec vitest run test/unit/transaction.test.ts test/integration/transaction.test.ts test/integration/prisma-lifecycle.test.ts test/architecture test/contract --no-file-parallelism`，**11 文件 239 通过、0 失败、0 跳过**；日志 `/tmp/billing-m2b-root-r1-final-gates.log`。
- Root 使用真实 NestFactory.createApplicationContext，分别从源码 tsx 与构建后 node 加载 DatabaseModule，验证持久写/读、ready→closed、已注入服务停止后不执行根 callback、重复关闭；两个模式均通过，只创建/清理自有临时 PG database。此为数据库上下文 smoke，不是 Billing HTTP 或 provider sandbox。
- billing_model_r2 独立最终只读审查无剩余本切片 P1/P2。其“readRoot callback 内禁止独立 runRoot”意见经契约复核撤回：只读 client 不是任意 JS 回调的 sandbox，不承诺跨查询快照；原子读写必须用一个业务事务。事务内使用 captured root client 仍拒绝，不放宽已有保障。
- Root 另执行 `SCHEMA_ADMIN_URL=<同实例管理连接> pnpm prisma:check`，派生物无漂移；在自有 canonical 临时库运行 target-schema、prisma-generation、prisma-persistence、transaction、schema-drift、schema-installation、postgres-schema、ownership，**8 文件 102 通过、0 失败、0 跳过**，覆盖 fresh install/完整 catalog/拒绝非空安装/失败回滚，资源已清理。日志 `/tmp/billing-m2b-root-r1-schema.log` 与 `/tmp/billing-m2b-root-r1-schema-check.log`。
- Schema/generated/HTTP/旧业务 writer 未改。M1 全量旧业务 135 项失败仍属 M3/M4；本轮未重复全量旧业务 suite，不将定向绿代替整仓绿。后续仍需永久 key 绑定、AuditAppender/fenced Outbox、七模块及旧 pg 删除、worker/drain/恢复、v2 HTTP、消费者与完整发布验收。

## B8-M1b 机器契约执行卡（2026-09-13，目标契约已验收）

| 项 | 决定 |
|---|---|
| 目标/优先级 | P0：按API_CONTRACT M1b决定落实完整v2机器对象/操作、语义负例、artifact治理；不以泛型schema或文件存在冒充完成 |
| 基线 | `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，codex/billing-ts-prisma-alignment，85cd137b2d71f7b2bb1c0776e07f8524d5a76f04，起始clean；Root先改三设计/本卡后交接 |
| 角色 | billing_transaction_m2a唯一writer；billing_model_r2只读规格审查；Root接口裁决/质量审查/主树验收及Git；iam_billing_authorization已交只读消费者盘点 |
| 文件集 | contract/openapi/v2/openapi.yaml、contract/README；scripts/verify-openapi.ts与必要具名target验证helper；test/contract目标契约测试与必要architecture；三设计/CURRENT/INDEX/本卡。禁止SQL/generated Prisma/package/lock/runtime/其他仓写入 |
| 放置/删除 | v2在现有版本目录体系，不另建共享contract或operation模型；原位改stable v1及code-first双来源淘汰。当前v1只为未切换旧源码验证，M3同切删除原目录和旧校验分支，不延长兼容期 |
| 数据/依赖 | 无Schema变更；仅使用现有YAML/TS/Vitest，test可import具名验证helper；src不依赖scripts；绝不复制IAM ORM/DTO |
| 验证 | TDD目标文件/约束缺失RED→GREEN；解析/ref完整性、全部operation typed request/response/header/error/security/路径UUID/opaque字段/202查询、变异负例；pnpm contract:check/format:check/lint/typecheck/build及contract/architecture测试。旧135项业务集成失败保持M3待办，不换Schema造绿 |
| 交付 | Agent停写交文件及日志；Root独立验证后明确路径commit，不操作共享基础设施；v2运行时/消费者/Sandbox仍待验 |

M1b设计审查：billing_model_r2只读核查后仅提出billing_subject是否保留的P1；Root已固定必填原对象kind/ref、仅归因及user本人绑定，payer仅来自IAM。其余同步/异步、UUID/opaque、查询和provider ACK与31表一致，放行目标机器源/治理实现，未放行runtime。Root `pnpm contract:check` 基线仍17条旧route通过。

R1修复已将Catalog完整BFF凭据、Checkout额外subject断言、admin独立proxy凭据及Refund GET双认证组写入机器源；响应显式nullable、正金额、既有字段边界和逐operation错误语义已收紧。正式变异门覆盖删认证、消费token、成功表示、provider ACK、path UUID、permission、error语义、unknown字段及nullable。此记录仅为待Root验收的目标contract证据；runtime/consumer/provider sandbox仍未完成。

### Root M1b-R1 集成验收

- 交付基线`85cd137b2d71f7b2bb1c0776e07f8524d5a76f04`，8个本切片文件；v2 SHA256 `eb95b6ddf4c3e611ff3eb065bcb39dad97d47cbf2203f8d6fd8105f17a5b42ad`。v1仍`58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63`，SQL/Prisma/package/lock/业务源码未改。
- Root首轮独立变异探针发现8/8错误契约被接受（`/tmp/billing-m1b-root-mutations-red.log`），并核对源码找出BFF/admin凭据退化。审查员关于三个me已有BFF分支的初始意见经Root源码/v1核对撤回：三者保持user-only，不扩大权限。
- 修复后billing_model_r2只读复审无剩余本切片P1/P2；Root冻结树实际执行`pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm contract:check && pnpm exec vitest run test/contract test/architecture --no-file-parallelism`全部通过：**8文件204项通过，0失败/0跳过**。旧runtime17route与目标24operation分别报告。
- Root再执行独立探针：8/8变异被拒绝、24operation/ref/身份/ACK通过；官方OpenAPI3.1结构元Schema和41个JSON Schema组件通过；Draft202012+format实例15/15通过。上述官方元Schema/实例验证是本轮独立证据，不冒充已进入仓库CI。日志`/tmp/billing-m1b-r1-root-frozen-gates.log`。
- 不操作基础设施，不复跑未改变的135项旧业务失败，不称整仓全绿。v2未接入HTTP；Nest/Prisma业务writer、共享事务组、worker、消费者、源码/dist与provider sandbox/镜像仍未闭环。下一阶段直接进入M2一致性支持及M3/M4连续迁移。

## B8-M1 执行卡（2026-09-13，离线模型已验收；禁止部署）

| 项 | 决定 |
|---|---|
| 目标 | 将已审R2/R3模型落实canonical 31表、只读Prisma及真实Schema约束测试；中间态不部署，后续完整writer/contract/consumer目标不缩小 |
| 基线 | `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，codex/billing-ts-prisma-alignment，1dcac770796bf7f80740f5f30801a80d3bea2057，起始clean |
| 分工 | Root先写三设计/本卡；交接后billing_transaction_m2a为单一实现writer；billing_model_r2只读规格审查；Root只读并最终主树验证/Git提交 |
| 文件集 | database/schema.sql及正式生成schema/provenance；scripts/verify-sql-naming.ts；对应schema/Prisma/transaction架构与集成测试；三设计/CURRENT/INDEX/database README与本卡可交付修改，不改IAM/其他仓/package/lock/生产pg业务 |
| 放置 | 现有database canonical+generated，不另建schema；真实约束测试放现有test/integration，一文件覆盖独立模型不变量，不新建目录 |
| API边界 | 原v1运行时尚未切换；目标Billing内部UUID与外部opaque身份已定，M1离线canonical不暴露新HTTP。旧源码对新Schema不兼容属完整切片待办，不保留旧表维持假绿 |
| 验证 | isolated fresh install、catalog 31表/UUID/零FK/约束反例、prisma refresh/check重复生成、sql:check、typecheck/build/target tests；完整旧业务suite失败与后续writer owner逐项报告，不skip/削弱门禁 |
| 交付 | Agent只交文件/日志不操作index；Root独立审查+主树验证再按路径提交，任务状态只验收M1证据不宣称可发布 |

### Root 集成验收（2026-09-13）

- 实现基线 `8d3fe03`；schema SHA256 `3640580b1f1d2589a709fc20b6a90d279ce491b7728eb837583b860cdbe81a0c`，generated schema `077ce9810bb8d21f579e8b31fb8386ed0af1c351f88015dfa6cf95e1400b7fb3`，provenance `ec6f0d786c089db06536ab091df09ebbb581520b89af883cc6bc830ccae061c8`。提交由Root按本卡16文件串行完成，未改package/lock/HTTP/业务writer/其他仓。
- billing_model_r2只读规格终审：R1的Execution终态/dispatch、Provider attempt非负及测试覆盖缺口均在R2闭环，无剩余本切片P1/P2。Root另审生成链与测试变更，未删除原事务回滚、并发、锁或drift反例。
- Root真实独占临时数据库catalog：31表、429列、31个单列`id UUID`主键、0 FK；timestamp均UTC毫秒类型；三receipt/两outbox/两履约事实的旧物理表已删除。完整catalog差异门由32项真实drift测试覆盖，不维护第二份可编辑schema。
- Root命令 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm sql:check && pnpm contract:check && pnpm prisma:check` 全通过；contract仍17条旧运行时route，此结果不证明目标API已交付。日志 `/tmp/billing-m1-r2-root-gates.log`。
- Root独立约束探针：receipt/outbox/Checkout 21/21、Execution/Provider 11/11；先分别在固定旧snapshot复现3项Checkout和6项队列反例错误接受，再在R2全部通过。探针与catalog均只创建/清理自有template0数据库。
- Root全量命令：在本轮独占、已安装canonical的临时数据库设置DATABASE_URL，管理连接设置SCHEMA_ADMIN_URL，共享Redis DB4仅使用测试自建key，执行 `pnpm exec vitest run --no-file-parallelism --reporter=verbose`。实际 **67文件：41通过/26失败；756项：621通过/135失败/0跳过**，退出1；日志 `/tmp/billing-m1-r2-root-full-suite.log`。资源已清理。
- 本切片7个真实integration文件均通过：target-schema 4、prisma-generation 3、prisma-persistence 5、transaction 18、schema-drift 32、schema-installation 21、postgres-schema 5，共**88项**；ownership架构14项通过。真实失败仍为26个旧pg业务integration文件，访问已退出的payment/entitlement表或因此返回500。失败未删除、未skip，必须在M3完整业务writer/fixture替换后清零；此前e795快照的136失败中旧Schema名称架构断言现已修复。
- **范围限制**：仅验收M1离线模型，不可部署；未跑/未通过目标Nest HTTP、源码/dist新业务smoke、Scheduler消费者、provider sandbox及镜像验收。后续owner仍为Billing负责人，Root负责契约裁决/跨仓集成，整个Goal保持进行中。


## B8-R5 成熟方案对照：身份边界、账本与调度（2026-09-12，只读研究结论）

本轮用户要求重新深思并参考成熟方案。基线 Billing `6ba108f4fbe948fa3944df0754ce3868ae0abd0d`、IAM `0f06f33b7390c27c2a57170d3c8dfb74b6c51908`，均干净。
Root 调查实际源码与 Billing 参考；billing_model_r2（Sol）独立只读反向审查 IAM 边界；唯一写入仅 Root 本任务板。未修改生产代码、依赖、Schema 或合同，未运行/冒称新实现测试。本节补足决策依据，不另建任务中心，不将外部实现等同本仓已经实现。

### 纠正先前过度简化的说明

“运行时只有 Billing→IAM”属实；“IAM 中只是 Billing 命名”不准确。当前具名 verify 是在线授权决策点（PDP）：它认识 Billing resource/scope，组合当前 Tenant/User/Member/Session 事实并写审计。它有有限的授权语义耦合和同步可用性成本，并非零耦合。
边界保持：IAM 判断身份/委托当前有效性，不导入 Billing 包、不调用 Billing、不读取钱包/价格/hold/账本；Billing 判断付款主体映射、账户归属、价格、余额及可否预留扣减。IAM 的 allowed 不是“可以完成这笔扣款”。

| 候选 | 适配判断与首发建议 |
|---|---|
| A 现有专用在线 verify | 首发保留：满足当前成员/会话事实重读而不跨库；保留 resource/scope/client 隔离。承认 IAM/Redis/DB/Audit 故障会阻断新准入，不能用测试全绿证明延迟或SLO已经达标 |
| B Billing 直接标准 introspection + 本地业务 policy | 更标准、专用代码更少，但 JWT 的 scope/tenant 是签发时快照；当前框架 introspection 不天然重查 Member。先证明统一 active 的成员撤销语义，或明确接受剩余 token TTL 窗口，才可等价替换A |
| C JWT 本地验证 / 另建通用授权引擎 | 本地验证降低运行时耦合但有撤销窗口；新通用PDP不自动减少网络跳数或业务复杂度。当前没有证据值得再引入IAM产品/策略引擎或新的万能check接口 |

A 是有意取舍，不因已有投入就永久保留：后续验收须有端到端 timeout/负载/故障预算、验证与审计成本、拒绝新准入但保留已授权结算恢复的测试。在线重读只证明读取时刻状态；不保证成员撤销与 Billing 扣款跨库原子。decision_ref 不可重放作凭据，Billing admission/receipt 必须保留自己的账务依据。

### 外部事实与适配结论（均于2026-09-12核验）

| 一手依据 | 已核验事实 | Kokoro 取舍，不冒充外部要求 |
|---|---|---|
| [RFC7662](https://www.rfc-editor.org/rfc/rfc7662.html)、[RFC8707](https://www.rfc-editor.org/rfc/rfc8707.html) | 资源服务器向授权服务器内省token，调用方需认证；resource/audience有标准隔离机制 | 保留Billing audience与认证，不因去耦改为接受任意IAM token |
| [Keycloak Authorization Services](https://www.keycloak.org/docs/latest/authorization_services/index.html) | 显式区分PDP决策与资源服务器侧PEP执行 | 用此职责词汇解释现状，不引入Keycloak依赖、不宣称当前端点实现其协议 |
| [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider) | introspection权限由签发client/resource-server绑定决定；带sid的JWT可在session结束后被内省判为inactive，JWT claims仍是签发快照 | 本地精确版本仍1.7.3；文档不证明Member变更自动撤销。复用框架，不手写第二套OAuth |
| [Stripe Billing credits](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits) | grant与不可变追加ledger分开，有有效期/使用范围/消耗顺序；credits在invoice finalization时应用 | 借鉴永久grant来源与journal；其账单抵扣不是本仓实时hold/capture/release的替代，不再把渠道Payment成功等同Credit已发放 |
| [Lago钱包](https://getlago.com/docs/guide/wallet-and-prepaid-credits/overview) | 区分钱包充值/赠送/消费；ongoing balance是周期刷新的使用估计，而非本仓原子预留凭据 | 保留授权/余额投影/批次/流水/冻结分责，不用余额查询代替原子准入。未据文档推广多钱包或premium功能 |
| [Kill Bill部署文档](https://docs.killbill.io/latest/userguide_deployment)、[插件边界](https://docs.killbill.io/latest/plugin_introduction) | 持久事件与通知队列；内核/外部插件投递分离以免外部慢操作阻塞内核；插件经API而非直接改核心表 | 复用现有Scheduler唤醒，账务判断在Billing；渠道网络在事务外，未知结果恢复。合并outbox存储不代表合并所有worker并发/重试预算 |

另直接读取 Lago 固定源码 `c8edce86727dfeda27deb3742f53a5e68d929d85` 的 [WalletTransaction](https://github.com/getlago/lago-api/blob/c8edce86727dfeda27deb3742f53a5e68d929d85/app/models/wallet_transaction.rb) 与 [SettleService](https://github.com/getlago/lago-api/blob/c8edce86727dfeda27deb3742f53a5e68d929d85/app/services/wallet_transactions/settle_service.rb)：明确状态/方向/剩余量及settled更新后after_commit排webhook。这里只证实这些代码；未运行其测试，也不把after_commit独自当作崩溃窗口无丢失的证明。不开拷贝Ruby表/decimal类型/全套引擎的任务。

### 带入既有B8实施验收，不扩大产品范围

1. 先固定事实/状态机/唯一writer和失败恢复，再决定表与目录；31张表是当前模型结果，不是优化KPI。
2. IAM授权事实与Billing账务事实分开；scope/policy注册不带入钱包计算；依赖图分别检查源码import、HTTP调用、启动以及故障传播，不能只看import无环。
3. 共享Credit事务组仍一次Prisma callback提交本地事实/receipt/outbox；Redis丢失不使扣减重做；第三方HTTP不进入事务。
4. 单一outbox存储的namespace、领取过滤与worker预算必须证明核心账务任务不被慢provider/通知饿死。是否需要独立执行池以现有worker职责与隔离测试决定，不照搬Kill Bill的表数或新增消息总线。
5. Scheduler只决定何时投递；到期资格、幂等结果、批量边界及重复/迟到唤醒由Billing验证。部署工具注册与调度回调是不同控制流；避免互相等待启动，不把所有双向配置引用一概称为循环依赖。

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
| B7 / P1 / 工具链与架构门 | Billing / billing_toolchain_hardening / 独立reviewer | package/lock/TS/ESLint/format/CI/architecture精确集派前批准 | Node24、版本固定、完整typed gate；AST有效/违规样本替代禁modules/强制ports；单独格式切片 | B7a已验收058bdf3；B7b已验收3fd97f5；B7c已验收8fbf8e0（干净46dc851复验）；B7d已验收0f0e764；干净ce5b628复验443全套/157集成、0失败0跳过 |
| B8 / P0 / Nest+Prisma闭合业务切换 | Billing / 后续续派billing_owner / Root+独立reviewer | 先全量当前表到目标的保留/合并/删除映射/provider图/事务组卡，再授权src/SQL/contract/test/worker集 | 先稳定查询范式，后整个共享Credit事务组；同一事务不混pg/Prisma，旧实现随闭合切片删除；中间未闭合commit不发布 | B8-D1/D2a/D2c及D2d机制已审查；生产未切换，完整Schema/major及订阅商业资格仍待；后续顺序见B8-G，B9a前置而非循环依赖 |
| B9 / P1 / 契约与外部副作用 | Billing / 后续续派billing_owner / Root | owner contract先行；消费者另开owner任务，无本仓写入权 | envelope/request-id/UTC/error/202语义；checkout claim→网络→finalize及unknown恢复；实际消费者固定artifact | B9a契约裁决/机器源前置B8；B9b消费者与外部副作用随owner实现验收，不再笼统依赖B8 |
| B10 / P1 / 运行可靠性验收 | Billing / 后续续派billing_owner / Root | worker/reconciliation/retention/smoke与文档；派前批准文件集 | execution并发lease、orphan检测、append-only角色、预算取消、provider sandbox、CI PG16/镜像/DR分层证据 | 待派工 |

## B8-X3 跨仓授权前置与闭环顺序（2026-09-12）

用户最新授权 Root 自主规划必要跨仓边界，不再逐项询问常规技术决定。总目标仍是整仓 Billing；本卡不是将总 Goal 缩小到授权。
初始“System/IAM 不在写入范围”在本卡仅对下列 IAM 授权文件集扩展，其他 Root/子仓未提交变更继续排除。

| 项 | 决定 |
|---|---|
| ID / 目标 | B8-X3 / P0：IAM 发布 Billing 专用用户消费令牌及当前事实验证，消除配置无法修正的 RS256/EdDSA 与 audience/scope 差异 |
| Owner / 分工 | Root 总体方案、Git/验收及当前 IAM 唯一 writer；iam_billing_authorization（Sol）已停写交接；billing_model_r2（Sol）规格审查、billing_transaction_m2a（Sol）最终质量审查，只读；billing_pricing_r3前序只读依赖/运行调查 |
| 基线 | IAM `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-iam` HEAD `bf160be173ef473bebe8e4a93b74ec52c230f180` clean；Billing HEAD `5140f115f0f0cdacdf0dcff81c9b48ce5397c662` clean；Root SQL手册/Agent/uv.lock/.tmp排除 |
| 三面设计 | IAM `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-iam/docs/TECHNICAL_DESIGN.md`、`docs/API_CONTRACT.md`、`docs/DATA_MODEL.md` 均引用 ADR-006；schema不改，机器声明生成后Root审查再接消费者 |
| 文件集 | IAM `src/modules/auth` 中OAuth constants/claims/provisioning/billing verifier/introspection及必要module和Guard；`src/modules/authorization` 具名Billing controller/schema/service/持久事实读取；config/provisioning、scripts/provision-oauth.ts；对应test/unit/integration/contract/architecture与sdk；由正式命令生成contract和sdk输出；现有docs及ADR-006。不得改其他owner、canonical/lockfile/无关feature |
| 放置比较 | 采用既有Auth+Authorization功能模块，schema/verifier/编排分责；淘汰Billing复制IAM model、IAM新建支付模块和Agent proof作为个人钱包同步准入前置 |
| 数据/API/依赖 | ADR-006定义exclusive resource、外层tenant machine/内层user token、独立凭据、当前member与Audit短Prisma事务。IAM永不依赖Billing，SDK仅下游消费；17模型/零FK不改 |
| 验证 / 资源 | 正式Code+PKCE/refresh/provision+PG/Redis隔离库验证；双token/tenant/resource/scope反例、撤销、配置及故障矩阵；pnpm verify、test:integration、test:consumer、prisma:validate、source process；只复用共享实例，不reset他人资源 |
| 交付 | owner contract commit先于Billing consumer；Root按路径提交，writer不操作index/branch/commit。待审查→待集成验证→已验收，不能用生成/单测代替跨仓授权成功 |

### B8-X3 实施交接与当前验证

- IAM 设计 commit `8f0bf699fc89966df6c0cfa1748c7bc33f8407ef`；主链 worker 已停写，Root 独占接管负例、故障测试、修复、文档与最终验证。共享 index 仍只由 Root 操作。
- 真实 HTTP 16/16 通过：consent/PKCE、双 token、scope 省略/混合及 GET/form POST 多 resource、refresh 原 aud/scope 与双向跨资源拒绝、logout/client disable、membership/tenant、审计实际 insert 后 throw 的 rollback、提交期间 expiry 与已提交审计快照。日志 `/tmp/iam-billing-x3-root-http-snapshot-green.log`。
- 两名只读 reviewer 已撤销/关闭阻断：Billing resource 持久 readback、JWK 依赖 503 分类与明确快照时间语义均落实。新增真实 Nest module import DAG AST 门，不用 forwardRef 掩盖环。
- 首轮 full verify 619 pass/14 fail：2 旧架构断言修正，12 资源/子进程超时及 fail-fast 入口随后在单 worker 与正式入口修复后全部通过；不修改超时预算、不 skip。依赖 audit 8 high/1 moderate/1 low 属已有 lock 基线，单独安全修复后再放行发布，不能夹带进功能 commit。
- IAM 功能固定提交 `f279508a9a9fcc93e7505a7ec503b62313abfa01` 已验收：Root 干净树 verify 75 文件/636 项、integration 27 文件/146 项、仓外 consumer 2/2、process 1/1、Prisma/diff 全通过，0 失败/0 跳过；日志 `/tmp/iam-billing-x3-root.BIG0gT`。未改 Billing canonical/schema/src/依赖/消费者，不将 IAM owner 切片称为 Billing 完成。B8-X3-S 安全补丁独立进行。

### B8-X3-S：IAM 已有传递依赖安全补丁（独立提交）

| 项 | 决定 |
|---|---|
| Owner / writer / 审查 | IAM / Root 唯一 writer与commit / billing_model_r2只读依赖审查 |
| 基线 / 前置 | B8-X3功能实现完成审查后先独立提交，S不夹带进功能commit；原package/lock/schema hash见IAM验收记录 |
| 范围 | IAM `pnpm-workspace.yaml`精确parent overrides、pnpm正式生成lock；`docs/SECURITY.md`、CURRENT、ACCEPTANCE及本卡；不改生产源码/机器contract/Schema、不全局强制所有js-yaml到一个major |
| 决定 | `@hey-api/json-schema-ref-parser@1.4.4>js-yaml`4.3.2；`@prisma/config@7.10.0>deepmerge-ts`8.0.0；`prisma@7.10.0>mysql2`及`better-auth@1.7.3>mysql2`3.23.2；`@nestjs/platform-express@12.0.1>multer`2.3.0。精确parent路径已由pnpm why核实；实际mysql2实体来自Prisma，Better Auth optional peer仅约束安全版本，当前PG安装未materialize该可选边 |
| 兼容/退出 | 当前使用PG、没有Multer业务上传，不用未触达掩盖依赖告警；deepmerge-ts8仅Prisma配置依赖，完整Prisma generate/validate/schema+build+运行验证，不切换ORM/Auth核心版本。上游解除漏洞后复验移除override；不放宽release-age或peer gate |
| 验证 / 放行 | install frozen复验、pnpm why、audit五级0、verify/integration/consumer/process与schema/prisma；功能contract/Schema hash保持。失败不降级门禁；整仓Billing仍未完成 |

B8-X3-S 已验收：安全提交 `4280d092419d3cd8dd21c25a46f7de01ae03eece`，Root clean committed 验证 `/tmp/iam-billing-x3-root.zGTPkX`：verify 75 文件/636 项、真实 integration 27 文件/146 项、仓外 consumer 2/2、process 1/1、Prisma validate/diff 全通过，0 失败/0 跳过。全量/prod audit 五级 0；lock SHA256 `3a1a895ed06932367a67ab11fc6811ceb7a16f9071fbab2aae2f01abbb27b506`，schema/contract 与 f279508 不变。只读依赖审查已接收，Better Auth optional peer 精度建议已修复。IAM CURRENT/ACCEPTANCE 的安全切片“待固定提交”对应本条最终证据，不另写自引用 SHA 破坏 SDK clean pack。

### 唯一执行顺序与无循环依赖

1. B8-X3 IAM owner → Billing消费方契约：主体来自授权输出，body attribution不改付款钱包；对既有admission的capture/release由持久授权与受信执行证据裁决。
2. B8-M1/M2/M3/M4：31表canonical与receipt/outbox、整个共享Credit事务组同一Prisma callback事务切换；不让新Prisma Credit与旧pg Payment/Refund/Subscription分开提交。
3. Scheduler接入紧邻此事务组：专用Bearer只授expiry；一条root command按holds→grants处理并持久同一完整result，occurrence identity派生batch；删除手工batch/自有daemon双轨。
4. execution claim/retry/drain、reconciliation只读报告、provider unknown outcome和启动配置完善；consumer固定owner artifact后运行真实HTTP及源码/dist smoke。
5. 冻结commit重跑全门，明确真实支付sandbox/镜像等外部待验与配置步骤；未闭环代码缺口不得列成“配置即可”。

同步运行依赖：Billing→IAM；IAM不回调Billing。Scheduler→Billing投递，部署工具→Scheduler注册；Billing启动不同步调用Scheduler注册自身。
Billing模块依赖继续以TECHNICAL_DESIGN的Payment core/Credit叶节点及独立PaymentEvents orchestration图为准，禁止通过forwardRef/global provider掩盖环。
所有跨仓只消费owner HTTP/SDK/event，不共享ORM或数据库；事务局限owner，外部副作用通过持久状态/outbox/有界重试恢复。

### B8-X3-M：新增授权 operation 的治理元数据局部修复

Root 横向检查定位到本轮新增 operation 缺失 metadata，直接修复本轮职责，不把老 IAM 所有 operation 或 Root checker 重写混入。IAM 基线 `4280d092419d3cd8dd21c25a46f7de01ae03eece`，先完成其 clean consumer；Root 唯一 writer，billing_model_r2 只读语义审查。
文件只限既有 Billing controller、对应 contract test、正式生成 OpenAPI/SDK、API_CONTRACT 与本卡；不新增目录/模块，不改请求响应/Schema/业务算法。Nest 原生 ApiExtension 为唯一声明，生成物不手改。
精确 metadata：owner=kokoro-iam、visibility=internal-owner、stability=stable、idempotency=none、permission=iam:billing-authorization.verify。每次 verify 新写 Audit/生成 decision_ref，无 receipt/Idempotency-Key/结果重放，因此不是 read-only/required，SDK retryEligible=false 保持。
验证：新增契约断言先 RED，controller+正式生成后 GREEN；verify、真实授权 HTTP、固定提交 consumer 与 Root 检查该 operation 原违规消失；其余横向失败不隐藏。

B8-X3-M 已验收，最终 IAM consumer 基线为 `0f06f33b7390c27c2a57170d3c8dfb74b6c51908`（包含 f279508 功能与 4280d09 安全补丁）。RED `/tmp/iam-billing-x3-metadata-red.log` 1 失败，正式生成后 GREEN 1 通过；新增元数据不改 SDK 方法/生产响应/数据库，独立只读审查无阻断。
Root 最终 clean committed 复验 `/tmp/iam-billing-x3-root.ianFr2`：`VITEST_MAX_WORKERS=1 pnpm verify` 75 文件/636 项、`pnpm test:integration --no-file-parallelism` 27 文件/146 项、`pnpm test:consumer` 2/2、`pnpm test:process` 1/1、Prisma validate/diff 通过，全部 0 失败/0 跳过；Node24.20.0/pnpm12.3.4，复验后工作树干净。OpenAPI SHA256 `b76903a274c708910a791b47beefbeb9094a3a38269e07112c084aecce7d2579`；schema/lock 保持安全提交 hash。固定 artifact 由此 SHA 发布，不引用工作树或浮动分支。
Root 重跑规范检查 `/tmp/billing-x3-root-metadata-standard.log` 为 222 项失败（原 223），新 Billing verify metadata 项已消失，其余失败保留；不将该局部通过写成横向规范已全部通过。Billing 生产代码仍为 S4 `5140f115f0f0cdacdf0dcff81c9b48ce5397c662`，本轮 Billing 只更新任务交接；31 表/完整 Prisma writer 组、consumer、Scheduler 与运行恢复尚未实现闭环。

### B8-M1 下一切片的准确前置（不是再次征求常规决定）

billing_transaction_m2a 以 `b476eb27bda2040648b9e303109bb4d78c02a1fd` 只读复盘；Root 后续先统一三设计与 canonical，不能让 writer 自行发明列名或契约。用户已确认首发无真实数据，后文历史“等待数据/部署回答”不再阻塞；禁止据此重置任何共享库。

1. API 中仍并列 stable-v1 与目标 breaking，须用单一首发 major 决定覆盖历史未决表述；settlement caller identity 与 Billing UUID 分开，17 条 operation 的真实 request/response/envelope、ID 生成权及 settlement/refund 终态逐一机器化。审查建议新 major + 删除旧路径，不发布双轨；这只是待 Root 写入三设计的建议，未修改机器契约。
2. IAM owner artifact 已可用；Billing 消费方必须明确当前用户授权结果到唯一 CreditAccount subject 的映射，不把 body payer 当付款授权。既有 admission 的 capture/release 继续验证持久授权及受信执行证据，不能简单复用任意当前用户 token。
3. 35→31 映射已审定，canonical 开写前冻结 command namespace/identity-required/result schema version 登记，以及 outbox event identity/payload version/handler 登记；其余约束从现有 R2/R3 模型落实。Receipt 不能独立提交 processing，Outbox 不能空 handler ack，Fulfillment 要保留永久授权 digest/原 grant/journal 唯一来源。
4. 不单独部署新 DDL：Credit 全 writer + Metering admission/capture/release/expiry + Payment fulfillment/provider processing + Refund/Subscription Credit 效果及装配须作为完整事务组切换；查询、对账的旧表引用同时替换。整个切片完成后才可称运行闭环，不让新旧 pg/Prisma 两套 writer 共存。

### Root 横向门禁实际结果（2026-09-12）

Root `6b4e82e5eb41a47e5e739b6261a7ea42cf1c06f9`，保留原 SQL 手册/Agent/uv.lock/.tmp 等非本任务变更。`python3 scripts/verify-repository-topology.py` PASS；`python3 scripts/verify-ten-repository-standard.py` FAIL 223 项；`python3 -m pytest scripts/tests` 82 通过/2 失败。
手册测试失败是抽取样例数量 11≠18 与 TS 手册缺少被断言的“参考依据”标题。规范检查同时包含 ORM canonical/生成代码识别、TS/构建配置、OpenAPI metadata 与其他仓库问题；初次检查中的新 Billing verify operation 元数据缺口已由 B8-X3-M 修复并复验，最终尚余 222 项；不能把全部失败笼统称为无关或已修复。
日志 `/tmp/billing-x3-root-{repository-standard,topology,tests}.log`。本轮没有放宽 Root 门禁或覆盖其他 owner 文件。Root 负责检查器与正式手册的一致性裁决；真实 owner 不符合项回到对应 owner 切片。IAM 局部功能/安全门通过不代表这些横向门通过。

### B8-X1/X2只读结论（不是实现验收）

- B8-X3三面文档经billing_model_r2独立规格审查P1=0/P2=0，准许进入owner schema/controller声明与generation；源码运行、机器契约与仓外 SDK 已在上述固定 IAM 提交验证；Billing 消费方仍待实施。

- billing_model_r2审查专用Billing audience+IAM在线验证方案无否决项；要求双token隔离、真实resource/refresh、凭据隔离、错误顺序和TOCTOU边界。
- billing_pricing_r3核实Scheduler不发送schedule UUID，Billing不能重算原digest。认证后以稳定Idempotency-Key为receipt身份；request ID只作诊断，header漂移纳入digest冲突。
- 当前hold receipt与grant逐行事务分离；仅改Bearer/header仍不闭环。必须随Prisma事务组改为一个holds+grants root command，不再追加旧pg兼容编排。
- execution/reconciliation需要目标durable claim/read-only snapshot，禁止捎带第二套cron。所有上述实现门仍待实跑，不将本卡标为整仓完成。

## 阶段门

### B8-S4 当前扣减链路与 usage–hold 持久绑定（2026-09-12）

| 项目 | 本切片决定 |
|---|---|
| 目标 / 优先级 | P0：默认 UUID hold 可正常 capture；用量事件与 hold 持久一对一，重放不重复扣减 |
| 基线 | `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，`codex/billing-ts-prisma-alignment`，`ada75b2bec8a06759655a7238510a20ad5d075ed`，Billing 干净；Root SQL 手册/Agent/uv.lock/.tmp 排除 |
| Owner / 分工 | Billing Metering 现有唯一 usage writer；Root 先设计与原实现 RED，billing_transaction_m2a（Sol）唯一实现 writer，billing_model_r2 / billing_pricing_r3（Sol）只读审查，Root 串行 Git 与集成验收 |
| 位置比较 / 粒度 | 采用现有 usage-settlement-service.ts 与既有 integration 测试，修复真实调用链；淘汰新建 modules/metering 第二套服务，因为完整共享 Credit 事务组尚未切换。必要新增 usage-hold-binding.test.ts 独立承载绑定并发反例，不新建目录 |
| 数据 | canonical entitlement_usage_event 新增 credit_hold_id VARCHAR(36) NULL + UNIQUE，匹配当前 hold PK 类型；派生 event PK randomUUID，删除 hold:UUID 拼接。完整目标改名/UUID 类型仍随 M1/M3 全事务组一次切换，不偷偷收紧当前 v1 opaque ID 合同；无 FK，无迁移/兼容双轨 |
| 生命周期 / 依赖 | 继续使用现有 application withTransaction 与同一 connection；不接入独立 Prisma client、不新建事务框架。ensure 无锁读取 tenant 限定 hold/account 快照，普通双身份读与 INSERT ON CONFLICT DO NOTHING 后新快照重读；同身份完整字段相同才重放，standalone source 不由 ensure 抢绑。记录不授予消费权限，settle 持锁后最终校验 state；不新增先 event 后 hold 的反序。direct settle 在现有事务内 NULL→hold 首次绑定，异值/另 event 已占 hold 冲突；原 settlement 两项 UNIQUE 保留 |
| API / 删除项 | 17 条 HTTP contract 保持，内部方法签名不变；删除 synthetic event ID 和 shortHold 测试规避，不增加源 ID fallback。独立 recordUsageEvent 仍保留外部 source 幂等与 payload 校验 |
| 允许文件 | database/schema.sql；src/infrastructure/postgres/repositories/metering/usage-settlement-service.ts；test/integration/usage-settlement.test.ts、admission-command-receipts.test.ts、usage-hold-binding.test.ts；由 prisma:refresh 产生的已跟踪 Prisma schema/provenance。Root 负责三设计、CURRENT、IMPLEMENTATION_PLAN、ACCEPTANCE；新增 helper 或超出范围先报告 |
| 验证 | Root 先删短 ID fixture，真实 PG 观察旧默认 capture SQLSTATE22001 RED；writer 后续绑定测试也须先 RED，再实现。覆盖 direct binding、完整重放、tenant/subject/feature/source/payload 漂移、并发 ensure/抢占/同 hold settle 重放、失败原子回滚；完整 pnpm verify、test:integration、db:apply-schema、db:verify-schema、prisma:check、源码/dist smoke、git diff --check |
| 资源 / 交付 | 复用共享 PG/Redis，仅自建 template0 随机独占数据库；不 reset/flush/启动共享服务。writer 无 commit 权限，交付文件/hash/RED-GREEN；Root 主工作树重跑并显式路径提交 |
| 边界 | 当前 scoped 三设计通过后实施本 P0；不把此切片当完整 Nest/Prisma/31 表重构或付款授权/Scheduler 接线验收。用户已明确未上线无真实账务数据，不再将历史数据问题列为当前阻塞 |

状态：首轮实现已交接并停写；Root 默认 UUID RED 确认 3 合法 capture 均 SQLSTATE22001。首轮 Root verify 为 744 通过，但独立审查及 HTTP 边界发现以下未闭环项，不据此放行。

#### S4-R2 验收反例与必要范围增补

- 两位只读 Sol 审查要求：确定性数据库等待 barrier（不能仅用 Promise.all 冒称经过等待分支）；逐字段 tenant/subject/feature/quantity/dimensions/source 反例；尾部已有真实账务写入后的整组回滚；同 hold/source 并发返回同一落库 UUID。
- Root 确認生产边界：HTTP 合法 255 字符 invocation_id 在 authorize 中拼接 admission: 前缀写 VARCHAR(128) hold key，返回500/22001（`/tmp/billing-s4-http-boundary-red.log`）。capture 中同一外部 ID 也被拼入 VARCHAR(255) usage source。不是通过缩短 wire 上限修复。
- 扩大文件集仅加现有 `src/infrastructure/postgres/repositories/metering/billing-admission-service.ts`：内部 authorize/capture/release key 和 capture source 改用本地 admission UUID，外部 invocation_id 仍完整保存并由 admission receipt 身份/digest 去重；删除四处外部 invocation 拼接，不保留 fallback。当前是未上线 fresh-install，不做历史数据补丁/双读。
- 测试位置仍优先现有三个 integration 文件；若 barrier/资源 helper 承担独立变化原因，可新增同目录 `usage-hold-binding.fixture.ts`，不新建目录。范围无需新 API/schema/dependency；直接绑定异 hold 先于 event status 判错，prior replay 也校验 event 绑定与 tenant，防损坏关系被当成功重放。
- Writer 继续唯一写入、Root停写；R2须新增测试先 RED 再补生产。Root先前 HTTP smoke需按当前 wire `accepted_without_charge`/`rejected`语义断言，实际扣款/释放状态以数据库核验；本切片不私改响应词汇。


#### S4-R3 最终冻结与审查

Root拒收R2测试证据：固定名DDL遗留在runDB、session advisory lock未pin、尾部outbox断言JOIN已回滚settlement造成假绿。R3改独占canonical fixture、pin PoolClient与随机key/PID确认等待，尾部比较account/grant/allocation/hold/journal/usage/settlement/outbox/admission/receipt前后快照，重试另验只有一次效果。Root补更新database README当前catalog数量，不修改安装器。

- 最终production SHA256：usage service `567f63fd39210a61400478a18b65d5170ac51269f0e9f2d27ae97accd991570e`；admission service `f797a168b9de6354cb3f320c2cc134ce66349299ff4d0281cbb1fdcc0a691a8d`。
- 测试SHA256：usage binding `bfc7f1c489bc0b219aae9cbe85ee1a23234f01acd7cf38d83a5ffdc5c980571e`；fixture `8bf8b2eb3f050f15af1dd043efe0f5dde2b1691c5020790e768b3f37b624936b`；admission `aa0125aa6ecfd079a74717f753b587bb01e40017d1ad7ff6487851ddec6b1aeb`。
- canonical `4c2e0a53ba6608426ed3ec7d77af8d8138688c4213404d0d06c2d8cfe0e90d79`；generated Prisma schema `893ce71962887b6445d1a7c360a0d39ff5a7d1d4299174d623063ca124bf9c3a`。OpenAPI/dependencies/lock保持原字节。
- 数据与并发两位Sol审查员分别核以上冻结hash，最终范围内放行；Root自主检查与当前完整门仍是提交前置，不能拿writer通过代替。
- RED：Root原capture `/tmp/billing-s4-root-red.log` 3失败/4通过（另3因过滤跳过），真正22001；writer `/tmp/billing-s4-binding-red.log`也是原实现UUID失败；`/tmp/billing-s4-binding-concurrency-red.log`是在原实现仅临时隔离ID问题后两source都成功的绑定反例，不是纯原实现或missing-column证据。Root最大invocation HTTP `/tmp/billing-s4-http-boundary-red.log`先在authorize报500/22001。R3错误优先级 `/tmp/billing-s4-r3-order-red.log`先得到expected mismatch/actual not_recorded，后改生产。其余prior JOIN与绑定细分补测未全部具有独立前置RED，如实保留流程差异，不用上述三个RED冒称全程test-first。
- Writer最终 `/tmp/billing-s4-r2-final-green.log` 两文件23通过、同runDB catalog differences=[]/routines0/triggers0，lint/typecheck通过；这是交付证据，不是主控验收。
- Root独立源码HTTP `/tmp/billing-s4-http-source-green.log`：真实最大invocation/default UUID create/capture、同key与identity重放、drift409、release重放；一个event/settlement/debit，available90/held0，health/ready/认证/request ID/SIGTERM通过。不是真实provider或IAM付款授权验收。
- 官方语义核验（2026-09-12）：[PostgreSQL Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html)说明DO NOTHING后独立语句快照可见已提交winner；[唯一约束](https://www.postgresql.org/docs/current/ddl-constraints.html)说明默认允许多个NULL而非空唯一。实际兼容性以本轮PG18.4和生成工具实测为准。

#### S4 Root 主工作树完整验收（提交前冻结代码）

- `/tmp/billing-s4-root-verify.sh` session4196 exit0，完整日志 `/tmp/billing-s4-root.XbiDgD`。实际执行 `pnpm db:apply-schema`、`pnpm verify`（format/lint/typecheck/build/sql:check/contract:check/test）、`pnpm test:integration`、`pnpm db:verify-schema`、`pnpm prisma:check`、`python3 /tmp/billing-s4-root-smoke.py`、`git diff --check`，全部exit0。
- 全套66文件752通过；真实integration36文件235通过（属于前者子集，不相加），0失败0跳过。catalog35表369列128约束84索引、routines/triggers/rules/policies全部0、differences=[]；Prisma同源无漂移。最终文档变更另跑 `pnpm format:check` 与 `git diff --check`通过。
- 源码和dist真实HTTP均通过255字符invocation/default UUID预留→扣款→同key与换key重放→payload drift409→另笔预留/释放/重放，DB各一条event/settlement/debit、available90/held0；health200/ready200/匿名401/可信BFF catalog200/request ID匹配/SIGTERM退出0。没有外部支付请求。
- 自建 `billing_accept_s4_c60299e8dc8e4033986f` 在所有子进程/命令终态后正常drop；前一失败验收库及独立HTTP RED/GREEN库也由各自trap正常drop。没有FORCE、共享Redis清空、共享实例重启或其他owner数据修改。
- 本次实际缺陷/流程保留：首轮完整门虽744/227通过仍被新增HTTP边界探针击穿；R2测试环境/断言问题经Root拒收后才修正。没有将原有失败隐藏、改小wire长度或放宽门禁。基础设施断连时测试fixture初始化/清理的所有故障路径未做穷举注入，不把正常清理实测写成完整DR保证。
- 未运行/未交付：真实provider sandbox、Scheduler跨仓、CI PostgreSQL16、镜像/生产SLO、Nest与全部业务Prisma切换。当前HTTP返回词汇仍为原合同accepted_without_charge/rejected，实际账务状态由DB检查证明；付款授权、31表/receipt/outbox及完整锁图改造仍归Billing后续切片。Root其他SQL手册/Agent/uv.lock/.tmp改动不在本次提交。
- 状态：实现→双独立审查→Root主树集成验证已通过；Root负责按显式15文件提交，提交后再核干净HEAD与重跑同门。后续owner：Billing原负责人，Root负责整体Prisma与跨仓放行。

### B8-R4 / M2a 首发边界与事务组件实施卡（2026-09-12）

用户明确当前没有真实账务数据、服务尚未开放，要求先实现，配置后可用。首发沿Root API手册采用clean-slate v1目标，
不再等待历史数据迁移/仓外已发布客户的假设确认，不建设兼容层；这不授权重置任何共享数据库。旧章节的相关待确认文字是历史阶段记录，由本卡更新。

| 项 | 本轮决定 |
|---|---|
| 基线 | Billing `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing`，`codex/billing-ts-prisma-alignment`，`7d1df245a9657a99bc69bfd80809dd1dea102e11`，起始clean；Root既有SQL手册/Agent/.tmp不碰 |
| R4-A只读 / 模型审查 | billing_model_r2 / Sol，核IAM/Agent已实现与目标：execution proof verifier尚未上线，当前header和authorization/check不证明付款授权。Root不采纳把organization可见scope当付款权限或自动改组织钱包的建议；保留当前用户钱包商业语义，付款授权由对应owner闭合 |
| R4-B只读 / Scheduler | billing_pricing_r3 / Sol：现Scheduler仅Bearer+occurrence headers，Billing入口认证不匹配；静态batch_id会永久重放首批。目标由Billing接原生occurrence key并维护durable receipt，不新增Scheduler模板或Billing cron；对账和outbox不冒充已接入 |
| M2a目标 / 顺序 | D1已审定的事务生命周期组件与模型/API无耦合，作为M2独立前置切片先实现；M1表/HTTP与M3/M4生产切换仍按三设计门串行。不是用局部门放行整仓重写 |
| 唯一writer / 审查 / Git | billing_transaction_m2a / gpt-5.6-sol为实现writer；Root派出后停写Billing至交接；既有两位reviewer只读。Root统一index/commit，writer不提交 |
| 允许文件 | writer实际7文件：src/database/transaction.service.ts、transaction.types.ts、transaction.error.ts；test/unit/transaction.test.ts、test/integration/transaction.test.ts；追加授权test/architecture/billing-dependency-policy.ts、typescript-dependency-graph.test.ts。Root交接后维护既有三设计、任务板、CURRENT、ACCEPTANCE、INDEX；package/lock/canonical/generated/HTTP/旧pg组件/其他仓只读 |
| 放置比较 / 公开面 | 采用D1 src/database事务支持；不放Credit或全局旧infrastructure。具名run、requireActiveTransaction及事务外检查；scope/type、error与实现分开，Prisma callback API管理提交回滚，不自写BEGIN/COMMIT/SAVEPOINT |
| 数据 / 依赖 / 删除 | 复用固定Prisma7.10与Node ALS，无新依赖/Schema/API。组件不接入当前pg runtime，不同时开两套业务writer；完整cutover删除旧connection事务路径。普通CRUD仍typed；原始SQL仅固定set_config/只读事务设置及测试探针 |
| 红例 / 验收 | 同backend/txid、提交前外连接不可见、嵌套吞异常/falsey首因/SQL异常被吞仍回滚、跨tenant/actor拒绝、closed client、read-only快照、预算与回滚后池复用；普通错误和未知提交不自动重试。真实PG只在fixture自建随机库 |
| 主控实际命令 | Billing cwd、Node24.20.0/pnpm11.25.0：focused unit+SCHEMA_ADMIN_URL真实integration；随后format:check/lint/typecheck/build/sql:check/contract:check与相关architecture，完整回归按实际证据记录。未运行不冒称通过 |
| 并行关键路径 | writer实现M2a；Root只读复核Scheduler原生契约、IAM边界及验收反例，收到交付后独立复验。M2的receipt/outbox和完整业务重试仍另切片，不能把本组件标为M2全部完成 |

- [x] M2a组件与真实PG反例验证；初始test-first证据不足，流程差异如下，未冒称全程TDD。
- [x] Root规格审查、两位独立审查及修订复核；主工作树最终完整门禁通过。
- [x] 回填冻结源码、实际命令/数量/未运行及后续owner；由Root提交本切片，精确交付commit见本节Git历史与本轮最终报告。

#### M2a交付与实测（2026-09-12）

- 实现为263行具名TransactionService及上下文/错误定义，不新增依赖。Prisma7.10交互事务掌握提交回滚；每root轻量query extension共享传入Client的连接池，绑定自身ALS state，覆盖typed与raw错误。嵌套同client，root身份冻结，跨tenant/actor/mode、已关闭/lazy/foreign client、rollback-only拒绝；没有自动重试、SAVEPOINT、手工COMMIT或production unsafe SQL。
- 毫秒预算统一限制1..2147483647并核相对关系；数据库语句/锁预算和只读快照在同Prisma事务设置，超时上下文关闭。原始falsey/NaN首因保持，真正secondary用AggregateError附加，不把清理错误或提交未知变成再次扣款许可。
- 两项明确范围：本组件不创建/关闭外部传入Client，不代替未来PrismaService/Nest生命周期装配；没有开放rootRead或未守卫root client，也未进入当前Fastify/pg生产运行时。普通root查询入口、完整命令重试/取消、receipt/outbox及七模块writer归后续M2/M3/M4。
- Root首轮规格审查修正read-only测试吞断言、无先写数据的空回滚断言、未实际嵌套同client测试及closed/timeout反例。独立billing_model_r2要求timer上限与真实run-secondary分支；billing_pricing_r3要求并发测试初始化/中间失败始终release并observe后台事务；全部修订后两审查员范围内放行。未把reviewer提出的组织scope推导payer建议采纳为业务授权。
- Root最终冻结源码SHA256：transaction.service.ts=`80e239f387b6e81ccb534be6537dda2b31f354e443fc6d938ac5d012b4d77255`；integration transaction.test.ts=`cce8150a5dcece52805353f9cd01088d53bb688bb8f27437b033c04210036c02`。全套日志`/tmp/billing-m2a-root.yZu66U`；前轮738/223仅作旧冻结树记录，不替代最终结果。
- Node24.20.0/pnpm11.25.0、共享PG18.4/Redis实例、自建Billing随机DB：`pnpm db:apply-schema`、`pnpm verify`（format/lint/typecheck/build/sql/contract/test，**65文件740通过，0失败0跳过**）、`pnpm test:integration`（**35文件223通过，0失败0跳过**）、`pnpm db:verify-schema`（catalog differences=[]）、`pnpm prisma:check`均exit0。223是全套内的集成子集，不相加宣称963项不同测试。
- Root源码/dist API smoke均health200/ready200/anonymous401/trusted BFF catalog200/请求ID匹配/SIGTERM exit0，仅证明原运行时未回归。另以纯Node加载编译后的TransactionService/Prisma Client，在独占空库完成typed BIGINT精确值、嵌套同client提交、吞内层异常后写入全回滚；脚本`/tmp/billing-m2a-compiled-smoke.mjs`，exit0。这不是Nest装配或支付渠道验收。
- RED证据为复审时受控移除READ ONLY/预算上限的mutation反例，日志`/tmp/kokoro-billing-m2a-red-readonly.log`与`/tmp/kokoro-billing-m2a-red-timer-max.log`，移除后exit1、恢复后GREEN。首次类型/导入失败不是业务RED；这些后补证据不冒充最初test-first执行时序，后续切片必须先行为RED再实现。
- Root第一次独立超时探针以outer等待callback gate形成循环，Node unsettled top-level await exit13；属探针问题，未作为组件失败。其唯一随机DB经writer确认非其资源后精确清理；改为有界延时的探针返回closed和Prisma expired transaction，并在finally清库。最终全验、compiled smoke自建库/子进程均已清理，PG查询无billing_reference_*或billing_accept_m2a_*遗留，未flush共享Redis/重启服务。
- canonical/OpenAPI SHA仍分别57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd与58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63；package/lock/generated字节未改。没有真实provider配置，未运行Stripe/支付宝/微信sandbox、Scheduler跨仓投递、Nest运行时、镜像/CI PostgreSQL16或生产容量/SLO；Root任务外变更完整保留，总Goal未完成。
- 后续owner：Billing继续完整canonical与可信付款授权契约、31表目标及七模块生产切换；Scheduler接入同时修Bearer认证与occurrence-derived batch identity，不另建cron。Scheduler现成注册机器源的字段是顶层url/body、misfire_policy/overlap_policy，不是任意target/header模板；IAM/Agent授权扩展按其owner契约串行，平台资源scope不等于钱包扣款权限。


### B8-R3 设计收敛卡（2026-09-12）

用户批准认真打磨技术方案后连续推进；验收标准按事实正确性与真实门禁，不以“顶级”标签或单次大提交证明。

| 项 | 结论 |
|---|---|
| 基线 / Owner | Billing `a60db6de8cce48710b80fc9e71e475dbf2cd3a2c`、codex/billing-ts-prisma-alignment、工作树干净；绝对工作目录沿上文。Root `56624233`；SQL手册/Agent/.tmp既有变更排除 |
| Writer / 范围 | Root唯一Billing文档writer及Git；允许既有三设计、ADR-0003、CURRENT、IMPLEMENTATION_PLAN、必要README/INDEX入口。当前源码、机器契约、canonical、generated、lockfile均只读；本轮先冻结下两设计面，不预建模块 |
| 独立面A | billing_model_r2 / Sol / 只读：3receipt+2outbox的去重域、状态、消费、保留/故障路径，提出合并或保留的精确字段/约束与反例；基线当前commit |
| 独立面B | billing_pricing_r3 / Sol / 只读：价格/用量/admission/quota现有用例与本地消费者，区分按次销售价、token用量、provider成本；列字段保留/删除与契约影响，跨仓仅只读 |
| Root职责 | 保留总体架构决定，独立核查证据、来源与完整事务组；用已加载writing-plans方法细化同一任务板，不创建重复计划中心。汇合两面结果后修三设计冲突、列可执行顺序及真实剩余决策 |
| 位置 / 删除 | 继续在Credit/Metering及现有一致性支持边界内设计；比较保持分表与带显式namespace统一表、保留双价格路径与单一销售定价入口。删除目标中的过期强制布局，不以新目录/表数作为收益 |
| 验证 / 交付 | 两审查员只读、不启动基础设施或提交；Root核代码/contract证据后修改文档，独立复审和sql:check/contract:check/diff/链接验证。尚未运行的新模型integration明确待验，提交由Root逐owner切片 |

#### B8-R3 独立审查与主控验证

- 数据一致性审查billing_model_r2 / Sol：合表与scope/双唯一域/稳定event identity/partial UNIQUE/lease fence通过；首轮指出旧未完成事件迁移遗漏，已补保留原行死信+受审退役原因、completed_at=NULL、停旧worker及审计，禁止改义/空ack/普通requeue。复审无阻断。
- 定价审查billing_pricing_r3 / Sol：本地无有效用例反对完整snapshot与按次收敛；首轮补齐发布整组原子可见、历史price digest生成/验证及术语，复审无阻断。两审查员未改文件/Git/DB。
- Root独立复核actual receipt双域OR查询、两outbox约束/handler、admission定价/账户选择、publisher和Web quota读取。纠正reviewer将provider requeue INSERT载荷差异误读为冲突UPDATE覆写：实际旧row不改payload。发现付款账户绑定仍须R4闭合，未掩盖为已完成。
- 主控实跑Node24.20.0、pnpm11.25.0下`pnpm sql:check`通过、`pnpm contract:check`通过（17 routes）；`git diff --check`通过；6份文档代码围栏/本地链接检查通过。目标表盘点脚本证明当前35表各映射一次、31个目标表名；这不是目标DDL已经验证。
- 初次从Root执行`pnpm --dir kokoro-billing ...`被Corepack选择Root pnpm12.3.4后版本门拒绝；已从Billing工作目录使用锁定11.25.0重跑通过，无依赖升级/门禁放宽。
- 当前canonical SHA256仍57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd，OpenAPI仍58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63；manifest/lock也与起始HEAD字节一致。
- 本轮仅6份既有文档；业务源码/SQL/机器契约未改，未运行新的业务lint/typecheck/unit/build/integration/Prisma/schema-install/smoke/provider sandbox；不拿历史通过数证明新模型。无新服务/DB/Redis资源、未动Root既有变更。完整实施/数据与major门未通过，原Goal未完成。

#### 连续推进顺序与停止条件（R3之后，非重新开一轮泛审计）

R2/R3已经裁决的履约合并、幂等/事件存储、按次完整价目表不再反复重新选型；下一阶段把设计落实到机器事实源与完整事务组。
实现负责人在设计门通过后续派既有billing_toolchain_hardening；Root保持跨仓裁决、审查、Git和最终验证责任。同仓仍单一writer。

| 顺序 / 完成条件 | 文件与责任边界 | 验收 / 依赖 |
|---|---|---|
| R4 关闭安全/业务机器契约缺口 | Root先裁决三设计中的可信付款人/执行委托身份、付款accept后的效果与查询语义；Billing owner写唯一contract，消费者只读盘点 | 现create admission按billingSubject.ref选账户而payerRef仅存储，必须证明真实付款账户授权；实际数据/仓外调用方、stable major及订阅资格是剩余事实决策，不把非空字段当授权 |
| M1 形成完整目标机器模型 | Billing唯一writer：database/schema.sql、contract唯一机器源、生成链配置；目标31表全部列/约束/索引与17现operation及真实新增查询逐项对齐 | 先在独占空库验证canonical/catalog及只读Prisma生成；旧历史数据切换另门，禁止在共享DB试错。未闭合实现的中间状态不发布 |
| M2 完整事务与一致性支持 | 设计通过后允许src/database/prisma.service.ts、transaction.service.ts、command-receipt.repository.ts、outbox.repository.ts及对应具名类型/错误/测试；不建BaseRepository | 先测试红例再实现：同tx、rollback-only、双唯一域冲突/重放、lease失效晚写、ack未知、Redis丢失；`pnpm exec vitest run test/integration/transaction.test.ts test/integration/command-receipt.test.ts test/integration/outbox.test.ts --no-file-parallelism`（目标文件，尚未创建/执行） |
| M3 闭合Credit与Metering主链 | src/modules/credit的履约/预留/结算/冲正具名能力；src/modules/metering的feature-pricing与admission；相应unit/integration/architecture | 支付/订阅/退款依赖同Credit事务组；不能仅迁一个writer保留其他pg写Credit。完整快照、历史价格、来源追溯、零delta与默认UUID成功用例同时通过 |
| M4 Checkout/Payment/Refund/Subscription及worker | 既定七模块的公开能力与Nest装配、API/支付与执行worker/expiry入口；移除旧infrastructure pg业务查询、application转发、ports/factory镜像及Fastify入口 | 网络事务外claim→call→finalize、unknown恢复、受信provider/执行证据、失败重试/死信、完整HTTP终态，不以accepted当效果完成 |
| M5 消费者与运行验收 | Billing先交付固定contract artifact；Root顺序派BFF/Web/Agent对应owner更新本仓client，不跨仓共享ORM/SQL；quota字段与真实UI同切 | owner内unit/integration/contract/architecture/schema/build/source+dist smoke；再运行隔离跨仓消费者验收。provider sandbox/镜像/生产SLO证据分别列，不互相冒充 |

M2–M4作为同一闭合业务迁移的连续实施切片；每个切片可审查提交，但未完成全组前不部署，最终删除旧路径，不保留运行时fallback或双写。
每步执行前仅补该切片精确文件集/红例/提交权限，不重写整体架构；常规实现决定自主推进，真正的新业务/不可逆决定单独确认。

验收入口继续使用本仓现有`pnpm verify`、`pnpm test:integration`、`pnpm db:apply-schema`、`pnpm db:verify-schema`、`pnpm prisma:check`；
各运行资源必须由本任务独占命名创建并清理。M2示例文件路径是未来任务授权目标，不作为当前文件存在或测试通过的声明。

### B8-R2 事务规范固化与核心模型续审卡（2026-09-10）

| 项 | 本轮决定 |
|---|---|
| 任务 / 基线 | P0：将用户确认的Prisma事务API约定落入共享手册，并继续履约事实/业务事务建模；Billing `fff756c0606cf5e5e35d778e40dd8b2f9adbd850`，Root `bbf8251d`，Billing分支及绝对工作目录沿上文 |
| Owner / writer | Root唯一writer及提交人；Root手册拥有跨仓工程约定，Billing拥有业务模型；不修改System/IAM/其他业务仓 |
| 现状 / 排除 | Billing当前Fastify/pg与35表未切换；Root既有03 SQL手册、Agent gitlink及.tmp变更保留，均不暂存 |
| 位置 / 粒度 | 复用08 TypeScript手册§12.1/12.2为实现权威，04事务补充只链接；不新建跨仓事务SDK或重复规范文件。Billing复用三设计、CURRENT、任务板及必要ADR，不建新报告中心 |
| 范围 / 依赖 | Root允许修改08、04及Billing上述既有文档；当前SQL/生成Prisma/源码/机器契约/依赖只读。先统一事务与幂等语义，再收敛核心事实，整仓实现仍须三设计门 |
| 并行审查 | billing_model_r2 / gpt-5.6-sol / 只读：核acquisition与fulfillment当前writer/退款/订阅依赖，给合并边界与必要约束；Root负责总体裁决，不让reviewer改文件/提交/访问共享数据 |
| 验证 / 交付 | Root检查diff、文档链接和相关手册测试；新模型只记设计证据，未执行的数据库/业务门不冒称通过。提交按Root手册与Billing模型两个owner切片；审查与结果回填本卡 |

#### B8-R2 交付与验证记录

- Root三设计裁决：保留五个核心Credit职责；payment/subscription的acquisition与fulfillment合并为永久CreditFulfillment（成功事实，不合入可消耗grant）。每tenant/source只允许一个program/一次发放，授权漂移冲突、换key同identity/digest重放；直接保存grant/journal引用。退款零delta独立结果与Subscription T1/T2保持。
- 新模型入口：`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md`、`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md`、`/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md`，与ADR-0003共同修正“固定35表一对一”约束。未形成第二可编辑Schema。
- Root手册提交：`4e17f7f3888f45352330f35514dccfad7e15e7fb`，仅08与04；其他子仓引用统一事务约定，不复制Billing业务层。既有03 SQL/Agent/.tmp变更未触碰或暂存。
- 独立审查billing_model_r2（Sol）核对源writer及三设计/Root手册，未发现同source多program成功的有效用例；Root复核现journal来源唯一性。首轮指出ADR旧35表放行措辞，Root已修；同时明确retention原行映射与当前canonical盘点，避免历史描述与目标并列。审查员复核三处修订后结论无阻断（仅文档一致性）。
- 主控实际验证：`pnpm sql:check`通过；`pnpm contract:check`通过（17 routes）；两仓`git diff --check`通过；8份改动文档fence与本地链接检查通过。`python3 -m pytest scripts/tests/test_engineering_handbooks.py -q`为1通过/2失败；失败分别是旧18示例断言实际11、旧“参考依据”标题断言。通过HEAD手册快照在自有临时目录复现同两项失败，未放宽测试，临时目录自动清理。
- 本轮仅文档：未运行业务lint/typecheck/unit/build/真实integration/db:apply-schema/catalog/Prisma生成/smoke；未改源码/SQL/机器契约/依赖，静态SQL/17route通过不证明新模型已执行。未访问支付或共享数据库/Redis，没有新增服务或运行资源。
- 未决及后续owner：Billing继续评审receipt/outbox物理布局与按次/用量价格模型，再闭合目标canonical、生成Prisma、跨能力事务及消费者切片；真实历史数据/外部引用/major、订阅商业资格仍由对应切换门确认。本卡不放行清库、原位修改stable v1或整仓重写，也不将原Goal标为完成。

### B8-R 核心模型与结构复审卡

用户最新指示：支付对接不是当前重点；重新检查Billing本体SQL、model和整体结构，而非只升级框架/ORM。基线bf128f508d7489da6598bfb8df962f927945dec8，分支codex/billing-ts-prisma-alignment，Billing起始干净。此前S3局部可靠性修复不证明核心模型成熟。

| 项 | 本轮范围 |
|---|---|
| Owner / writer | Billing；Root唯一文档writer/Git，既有业务owner无变动。工作目录/手册/CODEBASE_MAP沿本任务板基线 |
| 数据审查 | billing_data_review / Astra / 只读：canonical35表、实际writer/query、DATA_MODEL与目标映射；区分有用业务事实、冗余投影、错误约束、身份/单位/状态问题，不默认35表必须一对一保留 |
| 结构审查 | billing_ts_review / Sol / 只读：当前分层与目标Nest模块/provider边界；评估只改目录/集中万能writer/通用框架过重风险，给出用例与文件证据 |
| Root工作 | 核心业务链、成熟模型原始资料与当前设计差异；综合保留/重做/删除建议，区分实施缺陷和目标设计缺陷 |
| 写入集 / 位置 | Root仅既有IMPLEMENTATION_PLAN与CURRENT，记录评审结果；比较新建报告中心与复用任务板，选后者。无源码/Schema/API/依赖/其他仓修改，不创建新模块/进程 |
| 前置与验收 | 先实查源码和当前标准，再审目标，不拿历史品牌引用作正确性证明；两审查员提交带绝对路径/行号的精简问题与建议，Root核证据。此轮只读审查不需访问数据库/外部支付或真实数据 |
| 交付/边界 | Root提交现有文档审查摘要；不据本次质疑直接清库/原位换stable v1/改变商业政策，不把旧目标一对一表改名当既定最终设计 |

#### B8-R审查结论与后续设计入口

Root、数据Astra、结构Sol分别读取当前源码/Schema，结论绑定bf128f5（本轮仅两文档修改）。此前“35表一对一映射”仅保留为旧迁移盘点，目标物理表数重新评估；B8-D1局部通过不再被解释为该表数与文件形状已最终合理。原七业务能力/单Billing owner目标保持，不先换栈再补模型。

| 结论 | 当前证据 / 分类 | 下一模型设计必须回答 |
|---|---|---|
| 保留account/grant/hold/allocation/journal五种职责 | schema.sql:5–87；usage-settlement-service.ts:254–274、442–520实际按批次占用/扣除/释放。不是仅因表多而冗余 | account是余额投影/并发锁锚点；grant是来源与有效期批次；hold是预留；allocation解释消费来源；journal是不可变积分增减。明确重建公式/唯一writer，勿把它称现金复式总账 |
| 重审acquisition/fulfillment两表 | payment/billing-settlement-service.ts:294–334、credit/subscription-grant-service.ts:53–95均同事务创建acquisition并直接committed fulfillment；当前无独立acquisition受理到异步fulfillment的writer证据 | 比较一个履约事实保存source/program/授权量/结果与保留独立授权、履约生命周期。合并是候选而非本轮批准；grant仍是可消耗批次，永久履约/退款/重放事实不能随之删掉 |
| 明确单位与账户维度 | account只有tenant+subject唯一键，grant.program不参与钱包隔离；Payment是amount_minor+currency，Credit是micros。quota字段仅发现读取，未发现生产配置/周期推进writer | 默认审查现有单可互换积分钱包，不擅加多币/分账功能。把Money、CreditAmount、UsageQuantity语义分开，比例与取整显式；确认quota究竟是有效需求还是历史壳 |
| 重做计费模型命名与唯一价格事实 | metering/billing-admission-service.ts:152–173把reservation_micros作为按次正式价格；usage-pricing-service.ts:129–153仍按token计算；两条真实源码路径不可被一次rename抹平 | 区分产品按次计费、用量计量、provider成本；逐一列当前消费者，决定有效profile并删除被替代模型。保留历史API行为不是最终双轨方案 |
| 三receipt/两outbox重新比较物理组织 | Schema中general/payment receipt近同形、admission多api_surface；payment outbox另有source-event UNIQUE。现目标已固定scope并由共享存储writer承接 | 分表与显式namespace统一表都可行；用去重域/状态/保留/查询负载比较，不把字段并集作为设计。维持成功result、旧独立命名空间及不同event唯一性；receipt和outbox仍是不同生命周期 |
| 删除反向分层，细化Credit内部职责 | application/credit/services/admin-grant-service.ts:19–26仅transaction转发；PG同名类负责规则/receipt/SQL。Payment、Refund、Metering当前直接写Credit。TS审查核同名port/factory镜像路径 | Service拥有编排/事务，复杂规则独立model/policy或纯函数，Repository做具名数据访问。Credit内部按余额/账本、预留、履约/冲正、兑换等真实用例组织，不生成新的四层模板或万能CreditService |

以上源码定位均相对本仓src/infrastructure/postgres/repositories（标application者除外）与database/schema.sql，行号绑定bf128f5。Root已独立读取两条履约创建链、钱包批次选择、定价路径和application转发复核；没有把静态发现写成运行复现。

结构审查的两个风险不升级为已证实缺陷：目标已经要求固定receipt/outbox scope，是否演化成万能框架取决于实现，不能预先制造三套/两套adapter或强制DI token；单实现直接注入具名class仍遵TS手册。`.public.ts`可合理导出Module/Provider，真正门禁应区分装配文件与业务调用者的具体symbol访问，不因barrel文件存在判违规。物理表数未定前也不固定对应capability数量。

成熟模型核验（2026-09-10）：[Lago traceability](https://docs.getlago.com/guide/wallet-and-prepaid-credits/traceability)提供充值来源与消费去向双向追溯；[Kill Bill subscription/entitlement](https://docs.killbill.io/latest/userguide_subscription#_subscription_and_entitlement)区分服务权益与计费生命周期。采用这些可核验的语义来评估Kokoro，不照搬完整发票/税务/现金总账或宣称安装了这些引擎；官方产品能力也不是本仓实现证据。

后续设计按“购买发放→按次预留/确认/释放→退款冲正→订阅周期/到期”列业务事实、状态机和同提交不变量，再形成ER模型、每表保留/合并/删除理由、具名能力/唯一writer矩阵，最后更新三设计与唯一canonical/Prisma生成。SQL-first和Prisma都不替代这一步。先比较仅搬目录（不采用）、按业务模型重构当前模块化单体（原Goal方向）、完整引擎承接（需另证能力覆盖/成本/唯一账务owner，非本轮已选）；不因外部引擎语言不同就直接排除，也不并排增加第二账本。

此轮未新建model/目录、改表/接口/依赖或执行任何数据库/支付操作。验证为只读源码/文档交叉审查、两文档diff和Git范围检查；未重跑业务测试，不借S3的712/205证明新模型已实现。实际数据/major/订阅政策在实施前仍需确认，但不作为停止本次纯模型审查的理由。


- [x] B0：当前门禁与真实依赖基线已记录。
- [x] B1/B2：独立审查已接收并由Root复核。
- [x] B3：明确Prisma目标与当前差异，三文档一致；B4局部数据设计经billing_data_review放行。
- [ ] 完整业务/Prisma重写门：catalog drift、生成链及隔离事务承接已通过；35表writer/DAG及Checkout/Refund/Subscription机制已审查；商业资格、完整canonical/机器major与消费者裁决仍待。局部内部放行不授权绕过Root §8.1。
- [x] B4交付、两阶段review、Root主工作树重跑验证与commit；见93c06df。
- [x] B5完整catalog drift与B6a/B6b生成/隔离事务承接已验收；B7亦已完成其工具链切片；这些均不代表生产Prisma切换。

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
基线：B7c实现8fbf8e0，干净46dc851已完整复验；B7d派发以本验收记录提交后的实际HEAD为起始SHA，工作树须干净。
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
- 所有子进程终态后正常drop本轮独占database；无FORCE/drop他人库/清共享Redis/重启共享服务。PG16 CI、Docker/provider sandbox/消费者未执行，不扩大放行。

图事实保持84手写src、215唯一内部依赖、304分kind/语法边、value SCC0、type/all各7组、39条有界旧type边；export来源绑定单独存储，不制造假运行边。
433相较B7b354净增79：80图/策略正反例，删除1条机械ports存在断言；其余有效门保留。
本切片仍保留B8精确HTTPcontext与type债，不声称Nest、Credit唯一writer或业务Prisma已经切换；B7d/B8/B9/B10及UUID capture等P0仍未完成。
当前冻结代码全门通过，相关文档更新后还会在干净HEAD复验；下方/后续记录该结果，不把本段提前称作干净HEAD验收。


### B7c 干净HEAD验收与B7d交接

Root在干净46dc8514e4d8300f92a3395b43a3ad062ca76282再次完整执行，session51256终态exit0，日志/tmp/billing-b7c-root.ZpBgDa。
实际：frozen install、独占空库apply、verify（59文件433通过/0失败0跳过，35.06s）、integration（32文件157通过/0失败0跳过，27.24s）、
catalog35/368/127/83零差异、Prisma零差异、源码/dist HTTP及SIGTERM smoke、audit五级0、diff check全部通过；结束git status仍干净。
SQL/OpenAPI完整hash保持任务板既有基线；本轮唯一billing_accept_b7c_099bf5b605eb467187b2正常清理，不干预他人连接/数据。
因此B7c仅静态依赖治理切片已验收，下一派发B7d格式化；B8生产迁移与全部已知P0/P1不因该门全绿而消失。
B7d唯一writer仍billing_toolchain_hardening（Astra），Root在本记录提交后停止写Billing；文档/Git/完整PG窗口由Root交接后负责。


## B7d 交付、例外与Root验收（2026-09-10）

实现：`0f0e7647d4531e94b2a1d7d8858e970850000c6e`；起始`8198fd8e4f7f05583e82a695953f0c6c85bb470c`。
同仓唯一writer billing_toolchain_hardening（Astra），冻结后Root明确153路径暂存/提交；没有其他仓/业务/SQL/contract变更。
交付`/tmp/billing-b7d-delivery-files.json`、`/tmp/billing-b7d-delivery-sha256.txt`；Root独立核对153hash与实际变更范围一致。

### 已批准且实证的格式兼容调整

- Prettier仅增加精确3.9.6及其lock importer/package/snapshot；未调整其他依赖、冷却期或安装安全策略。
- 153文件中146机械：142严格等于一遍`format(8198fd8文件)`；以下4个第一遍输出非幂等，经实证批准为两遍输出、第三遍不变：
  `src/application/metering/ports/metering-repository.ts`、`src/application/metering/services/billing-admission-service.ts`、
  `src/infrastructure/postgres/repositories/metering/billing-admission-service.ts`、`src/interfaces/http/server.ts`。
  差异仅参数/链式调用布局，没有ignore/手工改业务/无限format循环；Root独立重算146个，mismatch=0、unstable=0，
  证据`/tmp/billing-b7d-root-final-parity.json`。writer对218范围文件最后一遍hash零变化，Root最终实际format:check通过。
- 7非机械文件仅package/lock、两formatter配置、新formatting.test与以下两处批准修复：
  ownership原单引号文本断言在真实格式后漏报，改具名共用guard，真实源码和格式前后反例共用；
  verify-openapi的实际routePattern在左括号后增加\s*，修复格式换行导致5条stale；测试从真实脚本AST读取regex而非复制实现。
  route回归先1 RED、ownership先3 RED；最终不降低原规则，17条双向route parity通过。
- SQL/OpenAPI/生成schema/provenance四份authority与8198fd8逐字节一致；SQL SHA256 57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd，
  OpenAPI SHA256 58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63。

### 双审与实际全门

规格 billing_data_review（Astra）：153hash一致，format通过、6文件194 architecture通过，放行无P1/P2。
质量 billing_ts_review（Sol）：153hash一致，format/17route contract通过、6文件194 architecture通过（2.52s），放行无P1/P2。
Root完整执行脚本在`/var/folders/gn/wbk8wfbd047_wvwkwtyn331r0000gn/T/billing-b7d-root-prep-4if7znzm/verify.sh`。

首次session36563正常终态exit1，日志`/tmp/billing-b7d-root.H0hAqI`：443/157、catalog/Prisma已通过；临时smoke脚本误保留b7c数据库前缀断言，
在启动任何应用前失败。Root修正自身临时脚本的精确b7d前缀（保留资源保护），不改Billing代码/断言范围；原独占库正常清理后完整重跑。

重跑session91162正常终态exit0，日志`/tmp/billing-b7d-root.z47kfV`：
- Node24.20.0/pnpm11.25.0；frozen install、独占template0空库`pnpm db:apply-schema`退出0。
- `pnpm verify`退出0：format/lint/typecheck/build/sql/contract/test全部真实执行；60文件443通过，0失败0跳过，36.43s。
- `pnpm test:integration`退出0：32文件157通过，0失败0跳过，28.51s（全套子集，不相加）。
- `pnpm db:verify-schema`：35表368列127约束83索引零差异；`pnpm prisma:check`零漂移。
- 源码及当次dist实际启动：health200/ready200/匿名401/受信BFF catalog200、offers数组/request-id一致、SIGTERM退出0。
- `pnpm audit --json`五级0、`git diff --check`0；DATABASE_URL/SCHEMA_ADMIN_URL/REDIS_URL/REDIS_TEST_URL显式设置。
- 仅本轮创建的`billing_accept_b7d_de955d6b792e42e994c1`和`billing_accept_b7d_6e9fc2d9c17e44cf918d`在各自所有进程终态后正常删除，
  Root再次查询均不存在；没有FORCE、清空共享Redis或重启既有实例。

净增10测试（7格式门+3旧guard反例），原433回归保留。PG16 CI、镜像、provider sandbox、跨仓消费者与生产DR未执行。
本切片仅格式治理交付，Nest/Prisma生产迁移、Credit writer以及已知UUID capture/失败记账/pricing/poison outbox缺陷仍待B8–B10。
本记录提交后在干净HEAD再次完整验收；精确结果绑定该HEAD及日志，不把文档提交自动当作验证。

### B8只读事务与接收链审查交接（未放行业务重写）

Root候选仍保持35表一对一命名，不贸然合并3种receipt/2种outbox：固定scope、tenant/key/identity/digest不变量和payment outbox独有UNIQUE保留；
具名shared receipt/audit/outbox为数据库支持，不新增第8个业务模块，不提供任意表CRUD。业务receipt/audit/enqueue必须加入同一最外层事务。
数据审查提出3个需在三设计面正式落定的内部决定：usage内部UUID与结算前hold稳定绑定、inbox失败状态独立writer/fence、嵌套失败rollback-only或明确savepoint。
P2002后的已中止事务不能继续查询；有界重试只能在最外层全部回滚后进行。旧失败不能覆盖并发成功，独立失败记账不继承失败ALS事务。

B8-RF审查（billing_data_review，基线8198fd8+机械格式树）静态证实：HTTP settlement accept与两个refund入口仅记录receipt/fact/Recorded outbox并202；
生产payment worker只领取PaymentProviderEventReceived，未发现PaymentSettlementRecorded/PaymentReversalRecorded的生产接收者。
真正fulfillSettlement/reverseCredits只在ProviderEventProcessor串联；现有integration手动调用两步，不证明HTTP后续durable链。
当前技术文档和API部分表述为fact-only，但通用202写accepted for processing，终态语义尚缺。B8/B9必须明确接受事实与后续效果：
信息齐全时经同一owner幂等能力完成，或具名durable handler/失败恢复/查询；不得仅删worker过滤、从金额猜credit、依赖未来webhook补齐。
此结论为静态缺口而非运行复现，不新增外部provider退款功能；部署数据/仓外调用方及v1非UUID输入的breaking裁决仍待用户事实。


## B7d干净HEAD终验与B8-D1设计卡

前轮分类：进展；实现0f0e764与文档ce5b628已提交。Root在干净`ce5b6285e14e61f97dc16d1dd9d7dbc553358e66`完整复验，
session88972正常exit0，日志`/tmp/billing-b7d-root.2XTtur`：frozen/apply/verify（60文件443通过，35.91s）/integration（32文件157通过，27.77s）、
format/lint/type/build/SQL/17route、catalog35/368/127/83零差异、Prisma零漂移、源码/dist HTTP+SIGTERM、audit五级0、diff全部通过；0失败0跳过。
自己的`billing_accept_b7d_f8a5eb73a9354127a68d`正常清理且查询无残留；结束工作树干净。B7已验收，整体Goal仍active，生产仍Fastify/pg。

| 项目 | B8-D1任务卡 |
|---|---|
| 任务/完成条件 | P0内部模块/共享writer/事务失败策略与35表映射；独立数据和TS审查后冻结这些内部决定，不冒称B8全部门通过 |
| 归属 | Billing；Root唯一文档writer/Git；billing_data_review只读数据/事务审查，billing_ts_review只读模块/公开API审查；沿用Astra/Sol |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，ce5b628，起始干净 |
| 文件范围 | 仅现有docs/TECHNICAL_DESIGN.md、docs/DATA_MODEL.md、docs/API_CONTRACT.md、docs/IMPLEMENTATION_PLAN.md、docs/CURRENT.md；无新目录、源码、SQL、机器contract或其他仓写入 |
| 放置比较/粒度 | 复用三设计面与唯一任务板，拒绝另起design/task中心；模块/事务规则在TECHNICAL_DESIGN，映射/约束在DATA_MODEL，breaking边界在API_CONTRACT，互相链接不复制机器字段 |
| 依赖/删除 | 已验B5/B6/B7；B8-D2待真实部署事实/major决定、HTTP后续终态、Checkout恢复与retention；业务切换时删除旧pg writer/port/factory与全局机械层，不现在误删有效保障 |
| 验证 | 文档35映射与当前SQL表集合一一对应、目标名字唯一；候选模块图静态无环；当前pnpm sql:check/contract:check；review仅放行内部方案，不替代未来Nest provider图/真实PG事务测试 |
| 交付 | Root文档commit，两个reviewer绑定冻结hash；审查问题回到同一文件闭环；下一可写slice须单独列源码文件/RED-GREEN矩阵并通过实际相应设计门 |

B8-D1三项内部裁决：usage event以应用UUID作为资源ID并在event持久化可空hold引用/唯一绑定；Payment inbox独立attempt token writer而不复制outbox lease；
嵌套失败rollback-only，最外层回滚后有界重试，不引入savepoint。Module DAG区分Payment core与事件编排子模块，避免Refund反向环。
验收矩阵对应TECHNICAL_DESIGN事务表：backend/txid及外连接可见性、深层故障全回滚、catch嵌套错误仍拒绝提交、tenant/生命周期隔离、
key/identity/digest冲突、unique失败后整命令恢复、默认UUID capture/hold-event配对、pricing双成功、旧lease不能ack、poison decode死信、旧失败不覆盖成功。
B8-D2/API和完整Schema仍有明确未决项，禁止用本轮只读设计门作为整体生产重写授权。


用户补充（2026-09-10）：Billing是关键服务，要求建立在成熟基础上，支付平台对接要完整、方便。框架/ORM/支付SDK优先采用稳定官方能力，
不自造支付协议、签名算法或第二套账务基础框架；依赖成熟不等于本仓可靠性自动成立，仍需并发、重放、退款、未知结果、恢复与沙箱证据。
用户已明确“staapi”指Stripe API，并要求国内支付渠道与Billing本体也优先复用成熟能力；现有支付宝/微信adapter纳入评估，不据“等等”自动新增未知provider。当前已有Stripe实现可先审计，
接入配置、凭据校验、测试模式、Webhook注册说明、错误诊断及runbook纳入后续provider验收，而不是仅验证HTTP连通。

本次澄清的代码/历史证据：当前package固定stripe22.6.1，StripeCheckoutProvider调用官方checkout.sessions.create；支付宝/微信主要为本仓node:crypto回调验签/解密与事件解析，尚无对应完整下单provider，不能称已统一使用官方SDK或已完成国内支付闭环。Root历史32/48号Billing研究文档引用OpenMeter/Lago/Kill Bill/Medusa，记录“借鉴模型、不直接部署整套引擎”的旧选择；这些历史技术栈描述不覆盖当前ADR-0003，也不证明目前已安装计费引擎。后续选型须明确“直接复用SDK/托管能力、引擎承接、仅借鉴模型”的区别，比较真实功能覆盖、账务唯一owner、运维与许可证成本后裁决；本次没有批准新的跨仓owner、第二账本或数据迁移。Stripe名称已确认，真实账务/外部消费者、major切换及订阅商业资格仍独立待决。


### B8-D1首轮独立审查与修订

数据Astra核5hash后内部方向放行，要求实现卡明确event-hold匹配、最后一次commit后ack丢失的只读结果恢复、provider编排不嵌套claim root receipt。
TS Sol发现P1嵌套scope漂移、P2首个rollback原因丢失、P2跨模块锁/快照查询可能错用root client；Root接受并补入TECHNICAL_DESIGN。
当前修订明确callback前tenant/actor匹配与rollback-only、hasRollbackCause保存falsey首因、transaction-required read/lock与同一readonly快照、
root/effect入口区分；DATA_MODEL补settlement与event.hold绑定相等。未改源码/SQL/机器contract，修订后重新冻结五文档并复审。


### B8-D1-R2放行与当前Stripe适配器证据

数据Astra首轮与TS Sol R2均放行内部决定；R2五文档hash为`/tmp/billing-b8-d1-r2-sha256.txt`。
首轮1P1/2P2已按实际建议修订，剩余B8-D2与整体业务切换未放行。Root本轮仅修改原有五文档；当前SQL/OpenAPI字节不变，
`pnpm sql:check`与`pnpm contract:check`（17routes）实际exit0；35目标映射与当前表集合精确一致且目标名唯一，候选模块声明DAG无环。
这些命令验证当前机器源及文档内部一致性，不证明尚未生成的目标Schema或未来Nest provider图。运行代码未变，全量运行证据仍绑定ce5b628。

用户要求成熟基础/方便对接后，Root针对当前已有Stripe作本地实跑探针（未把“staapi”未经确认改称Stripe）：
脚本`/tmp/billing-b8-stripe-probe.mjs`，结果`/tmp/billing-b8-stripe-probe.json`；命令`node --import tsx /tmp/billing-b8-stripe-probe.mjs`退出0，
基线ce5b628。使用实际StripeCheckoutProvider与StripeWebhookProvider，仅截获SDK sessions.create以记录真实输入，未请求Stripe/数据库，没有支付或账户改动。

| 缺口 | 实际观察 | 目标验收 |
|---|---|---|
| 未支付状态归一化 | checkout.session.completed+payment_status=unpaid被parseEvent返回payment_succeeded；不是实际扣款/发放实证 | completed不等于已收款；显式校验payment_status与可信订单/金额/币种，异步成功/失败、重复/乱序不提前或重复发放 |
| 创建与回调metadata不一致 | 实际createSession发送checkoutId/tenantId/subjectId；以该subscription_data.metadata构造回调，实际parser返回subscription=null，因为当前要求teamId/planId | 按持久checkout/报价映射解析subject与plan，不强迫消费者补旧字段alias；真实创建输出→回调→owner效果在同一回归链验证 |
| 当前API周期结构 | 带items.data.current_period_start/end的事件，隔离补齐旧metadata后仍解析两周期为NULL；processor对active+grant进一步抛period_missing（此后半段是源码静态证据） | 固定并验证SDK请求/事件destination API版本、使用对应官方对象结构；多item周期与账单支付/试用发放规则显式建模 |

2026-09-10官方语义核验：
- [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)：需要检查payment_status，延迟支付可能在completed后才成功；必须防重复/并发fulfillment。
- [Stripe Webhooks](https://docs.stripe.com/webhooks)：raw body验签、快速持久接收、重复及乱序、event destination版本需明确；不依赖事件到达顺序。
- [Subscription item-level periods](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end)：Basil起周期在subscription item，旧subscription顶层字段移除。
- [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)：invoice支付与订阅状态为不同事实；trial/access及计费发放政策需显式裁决，不能仅凭active推断所有账单已付。

本地已装stripe22.6.1的esm/apiVersion.js实际默认`2026-08-26.dahlia`；当前constructor未显式设置API版本，而webhook parser还取旧顶层周期。
官方文档证明provider语义，本地探针证明本仓适配缺口，两者均不冒充provider sandbox。下一provider切片须把官方SDK/事件合同、
稳定付款/退款identity、schema/runtime语义、配置自检、沙箱正反例与接入runbook一起闭环；不以SDK安装或mock happy-path称“接入完成”。


## B8-S0付款准入修复卡（局部设计，整体B8-D2仍未通过）

前轮为进展：45fec83冻结内部设计并实证Stripe适配缺口。当前起始45fec83199e08f83fdf9db42ae955f387b8c662c，工作树起始干净。
用户强调关键服务成熟性，优先关闭已复现的未付款事件被归一化为成功，而非等待大重构后再修；不借此宣称完整Stripe接入完成。

| 项目 | 决定 |
|---|---|
| 任务/目标 | B8-S0 / P0风险收敛：一次性Stripe付款严格paid-only准入，未支付零账务效果、后续支付恰一次发放 |
| Owner/角色 | Billing Payment；billing_toolchain_hardening（沿用Astra）唯一writer；数据Astra局部设计/测试证据审查，TS Sol代码审查；Root设计/Git/完整验收 |
| 三文档局部门 | TECHNICAL_DESIGN B8-S0确定分支与文件；API_CONTRACT B8-S0说明缺省/非法输入收窄但wire机器源不变；DATA_MODEL B8-S0明确无DDL/事务边界变化。审查通过仅放行本4文件修复 |
| 文件集 | src/infrastructure/providers/payment/adapters/stripe/stripe-webhook-provider.ts；test/unit/provider-registry.test.ts；新增test/unit/stripe-payment-gating.test.ts与test/integration/stripe-payment-gating.test.ts |
| 目录/粒度 | 生产复用原owner文件；比较扩充混合provider测试vs独立付款准入测试，选择现有unit/integration目录各一个专项文件，无新目录或公共测试框架 |
| 输入规则 | completed/async_payment_succeeded + mode=payment + payment_status=paid + subscription为缺省/NULL才成功；非paid/非payment/缺省/畸形mode-status/非NULL subscription保持原event type并不携带effect字段 |
| 保留/排除 | raw body与官方SDK验签、provider account→tenant、inbox去重、PG业务事务不变；不改SQL/OpenAPI/其他provider、订阅解析/SDK版本、Nest/Prisma切换或任何其他仓 |
| TDD | 先矩阵RED及真实PG未支付却创建账务的RED，后最小provider分支修复；合法fixture补真实Stripe mode/payment_status；不mock被测parser/inbox/processor/SQL |
| 独占资源 | 测试文件每例随机tenant/业务ID，复用Root指定本轮独占database；worker不创建/删除共享服务/库、不清共享Redis；Root按需分配一次PG窗口 |
| 验证 | 单元矩阵（两事件类型×paid/unpaid/no_payment_required/缺省/异常值×payment/subscription/setup/缺省；subscription交叉）；真实runtime注入HTTP、SDK签名、inbox→OutboxWorker→processor→PG表断言、重复/迟到事件与坏签名；冻结后Root完整verify/integration/catalog/Prisma/源码dist smoke/audit |
| 交付 | worker不Git/不文档；Root明确路径commit，先规格再代码review与独占全验。完整provider沙箱/API版本/订阅metadata/周期与B8-D2仍待后续，不以局部通过缩小Goal |

no_payment_required在当前正金额且无免费发放设计的profile不进入paid-only效果。未来支持免费权益必须独立定义，不把未知或不支持模式自动当支付成功。
生产代码只需紧凑纯分支，不引入通用event规则引擎或支付框架；所有新增测试只服务本局部付款准入。


B8-S0数据设计审查已放行（billing_data_review/Astra，4文档hash均匹配/tmp/billing-b8-s0-design-sha256.txt，无P1/P2）。
补验收要求：只门控两种Checkout事件，不关闭既有退款/订阅分支；同Checkout的unpaid→不同event ID的paid async→同成功event重放→迟到unpaid，
每步检查settlement/grant/journal/余额；未付款事件inbox ignored/outbox完成而Checkout未取消；坏签名零inbox。
Root会分配独占数据库供writer跑真实RED/GREEN，writer只执行卡内测试并关闭自身连接，不创建/drop库、不改共享服务；全部测试session终态后Root清理。
实际HTTP优先使用createBillingRuntime的jwks模式以启用真实provider account→tenant查询；本测试不请求用户JWT，JWKS无需网络，Stripe API密钥不配置，
官方SDK仅构造本地测试签名。Redis只复用既有实例，资源均随机tenant/ID；不把application方法手动调用冒称HTTP入口验证。

### B8-S0冻结交付与Root完整验收

实现基线8860e7e3004f7df0ebd0fc9143d4fd33886bc0dc；billing_toolchain_hardening已停止写入，Root接管提交及这两份状态文档。
代码仅任务卡4文件，冻结清单`/tmp/billing-s0-delivery-sha256.txt`，Root及两个reviewer全部复核一致；SQL/OpenAPI/依赖未变。
生产变化只有两种Checkout的paid-only门及保留非Checkout subscription字段原校验的局部refine；未知/非NULL引用在Checkout忽略，不向退款/订阅扩散。
新测试按once报价配置，仅本地持久化hosted-session绑定，未调用Stripe创建接口，未伪装成真实provider sandbox。

TDD：单元初次211失败/10通过；Root发现第一版integration误用month报价后，writer改once并撤下自身生产补丁重跑同一测试，
真实RED仍在unpaid后产生settlement/account/grant/journal各1、余额1000000处失败，日志`/tmp/billing-s0-integration-once-red.log`。
恢复补丁后定向3文件230通过；全部session正常终态，最后96780退出0。纯非infra28文件504通过不作为真实集成证据。
测试实际使用runtime HTTP注入、JWKS配置模式下provider account→tenant查询、官方SDK本地签名、inbox/outbox/processor与SQL；没有JWKS请求或Stripe网络。
同Checkout unpaid→不同ID async paid→同成功事件重放→迟到unpaid，逐步检查账务、inbox状态与outbox完成；坏签名零inbox。

独立规格billing_data_review/Astra放行无P1/P2，自跑2文件229 unit通过；质量billing_ts_review/Sol放行无P1/P2，自跑unit/architecture/contract 9文件426通过，2.61s。
两者没有操作数据库或改写文件。Root检查最终diff、scope和hash后独立完整运行：
`/bin/bash /var/folders/gn/wbk8wfbd047_wvwkwtyn331r0000gn/T/billing-b8s0-root-orhw700a/verify.sh`，session14291正常exit0，日志`/tmp/billing-b8s0-root.bRJp6k`。

- Node24.20.0/pnpm11.25.0；`pnpm install --frozen-lockfile`、template0独占空库`pnpm db:apply-schema`退出0。
- `pnpm verify`包含format/lint/typecheck/build/SQL/contract/test：62文件665通过，0失败0跳过，38.11s；新增221 unit和1 integration，原443回归保留。
- `pnpm test:integration`：33文件158通过，0失败0跳过，29.42s；是全套子集，不与665相加。
- `pnpm db:verify-schema`：35表368列127约束83索引零差异；`pnpm prisma:check`零漂移；SQL/OpenAPI SHA与卡前相同。
- 源码与当次dist均实际启动：health200/ready200/匿名401/受信BFF catalog200，request-id一致，SIGTERM退出0。
- `pnpm audit --json`五级0、`git diff --check`退出0；显式设置DATABASE_URL/SCHEMA_ADMIN_URL/REDIS_URL/REDIS_TEST_URL。
- writer库billing_s0_writer_fce6253a56fc43dba89a在writer终态及零连接后正常删除；Root验收库billing_accept_b8s0_af7f4a7aefc942a5bbb5在全部命令终态后正常删除，再查询二者均不存在。未FORCE、清共享Redis或重启既有实例。

本次仅付款准入切片。PG16 CI、镜像、Stripe sandbox/完整订阅与退款、消费者cutover、生产SLO/DR未执行；Nest/Prisma生产writer、UUID capture、pricing并发、失败状态与poison outbox等已知缺口仍待B8–B10。
Root按明确路径提交这4个代码/测试文件及CURRENT/本任务板，随后在干净提交重跑同一完整脚本；文档不自动继承为干净HEAD的验收结果。


## B8-D2a Checkout恢复设计卡

上一轮分类：进展。8b55a578f6323e12af3760527e466d10ac6ba59a已在干净HEAD复验，session34112正常exit0，
日志`/tmp/billing-b8s0-root.5cbfbz`：62文件665通过38.29s、33文件158集成通过29.31s、0失败0跳过；
frozen/apply/format/lint/type/build/SQL/17route/catalog35/368/127/83/Prisma/源码dist smoke/audit五级0/diff全部通过。
自己的billing_accept_b8s0_aae2a0ffbf52418c955b正常删除并查询不存在，Billing工作树干净。B8-S0已验收，不缩减完整Goal。

| 项目 | B8-D2a任务卡 |
|---|---|
| 目标/优先级 | P0：冻结Checkout事务外调用、未知结果与恢复的内部状态/数据/依赖设计；不冒称完整B8-D2已通过 |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，8b55a57，起始干净 |
| Owner与角色 | Root唯一Billing文档writer/Git；billing_toolchain_hardening沿用Astra只读SDK deadline调查（仅/tmp自有探针/随机loopback HTTP server）；billing_data_review/Astra及billing_ts_review/Sol冻结后独立审查 |
| 文件集 | Root仅既有TECHNICAL_DESIGN、DATA_MODEL、API_CONTRACT、IMPLEMENTATION_PLAN、CURRENT；调查员不改Billing/Git/PG/Redis，不访问真实Stripe API，只清理自身HTTP server/进程 |
| 放置/粒度 | 复用三设计面及唯一任务表，不新建文档中心；Checkout owner承接完整session生命周期，不把网络await机械搬到Controller或创建通用支付任务框架 |
| 依赖/契约 | 基于B8-D1事务规则和S0付款门；核对Payment账户公开查询的无环依赖。新HTTP major/真实部署数据仍待事实确认，本轮只定义内部结果，机器v1原样保留 |
| 对比/删除 | 拒绝原事务内网络及只移await但无durable恢复；采用短事务claim/外部调用/短事务fenced finalize。实施闭环时删除旧checkout pg实现及仅Promise.race的假取消，不保留双写 |
| 数据 | 35表owner映射不增业务表；Checkout行保存请求快照、attempt/lease/恢复状态，SQL唯一canonical；本轮不应用DDL、不清真实数据 |
| 验证/交付 | 官方SDK/HTTP语义证据+本地实际deadline探针（如能实跑）；两位reviewer绑定5文档hash；Root核当前SQL/17route及图无环。实现后另验真实PG并发/崩溃/unknown/window/late response与完整门，不用文档测试代替实现 |


### B8-D2a实际SDK deadline证据

调查员沿用Astra。首版session52846/Root23381正常exit0，但前两场constructor直传overall<read，未满足runtime-config约束；
因此只保留为探索证据（run-first/results-first及root-run/root-results），不据此宣称可配置运行时实证。
修正后session70575正常exit0；最终探针`/tmp/billing-b8d2a-deadline/probe-final.mjs`，SHA256
1f2b1e1dff4a970aac59d708377a064ddaba623dee5dfbf2f1defbafa3d47524，全部场景先断言overall>=max(connect,read)。
Root核验hash后复制相同脚本，仅命令参数指定独立结果路径：
`node --import tsx /tmp/billing-b8d2a-deadline/root-final-probe.mjs /tmp/billing-b8d2a-deadline/root-final-results.json`，
session85554正常exit0；实际日志root-final-run.log位于同目录。

使用本仓真实StripeCheckoutProvider和Stripe22.6.1 SDK，只把实例host/port/protocol/httpClient指向自己随机loopback HTTP server；
sessions.create为透传原方法/原Promise，额外观察原Promise终态，不提供假返回值。未验证TLS connect agent、Stripe服务端幂等或真实sandbox。
Root四个合法配置场景均实跑断言通过：
- overall600ms/read400ms，首次收完body断连、SDK重试后响应延迟220ms：调用604.6ms报provider_timeout，原SDK740.4ms成功，证明超时未取消仍活跃请求。
- overall180ms/read90ms/retry1：调用182.8ms报超时；本地在总deadline后实际收到第二次POST，原SDK695.1ms才以ETIMEDOUT终结。
- maxNetworkRetries=0，server收到完整body后断连：实际2次POST且最终成功；普通socket timeout则1次。每个场景重试key保持相同。
- SDK原Promise、server延迟任务均await终态，4场景cleanup均sockets=0/listening=false，未触及PG/Redis/Stripe外网或Billing源码。

这些证据要求目标实现既取消本地I/O又持久保留unknown，且对SDK的特殊重试实测预算；不能把maxNetworkRetries=0或Promise.race称为恰一次执行保证。


### B8-D2a首轮审查与R2

数据Astra首轮内部方向放行，指出历史unknown和两种mode命名需在实施卡明确。TS Sol首轮1P1/2P2：
未知历史未持久、environment与session mode混名、独立3秒connect能力未选定。Root均接受并修改三设计面：
单调session_had_unknown+同SDK调用uncertainty、过期in_flight接管保守置true、failed CHECK/转换禁止抹去未知；
provider_environment与checkout_session_mode分别验证，恢复承接payment和subscription创建，setup没有业务不创建；
选择官方Undici Agent+FetchHttpClient而非自造取消层，给出独立connect预算、每attempt signal、共享受控dispatcher和关闭顺序。
2026-09-10 npm view undici实际exit0：8.10.2稳定、Node>=22.19.0、MIT、time.modified=2026-09-04；仅候选预核，未改package/lock，完整供应链/安装/故障门留实施。
R2继续只改原5文档，Schema/contract/源码字节不变；冻结后重审。当前提议的provider新账户环境字段、Checkout生命周期和完整SQL都仍未应用。


### B8-D2a-R2内部放行与边界

数据Astra与TS Sol均复核`/tmp/billing-b8-d2a-r2-sha256.txt`五hash并放行内部设计，无剩余P1/P2；Root仅追加本状态记录及文档标题/当前态，不新增设计决定。
Root执行当前`pnpm sql:check`、`pnpm contract:check`（17routes）、`git diff --check`均exit0；SQL/OpenAPI SHA与8b55a57一致。
独立文本核验35表映射一一对应且目标名唯一，七feature+PaymentEvents子模块图无环，Checkout新增仅Payment核心读取边。
Root临时图解析首版用Unicode词边界误漏payment核心，assert退出1；改为ASCII模块名边界后同文档通过，未改真实架构门或降低其规则。
这些校验证明当前机器源/候选文档一致性，不证明未来DDL已执行或Nest容器已实例化。

本轮未改源码/测试/依赖/机器契约，只在本地临时HTTP server执行4故障场景并终态清理；没有PG/Redis变更，账务完整测试不重复冒充本轮设计实现。
最近全量运行证据仍绑定8b55a57的665/158及任务板前段；新设计目标全部须在后续实现重新验证。
本门文件：/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md、
/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md、
/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md。
尚未放行：major API与真实部署/数据演进、完整canonical Schema、订阅/退款/202终态、retention/权限，以及依赖安装或生产代码切换。
下一设计面继续闭合这些剩余项；不能把内部设计审查代替完整B8切换，也不能长期停留Fastify/pg而宣布Goal完成。


## B8-D2b付款/退款入口终态核查卡

上一轮分类：进展。2a92260095bb7f9b8df29ff39b61d47c8e5bde00已提交Checkout内部恢复设计；双审R2放行，
干净HEAD SQL/17route契约检查退出0。当前起始该HEAD且Billing干净，真实数据/v1仓外调用方尚待用户确认。

| 项目 | 本轮范围 |
|---|---|
| 目标 | 将付款/退款三HTTP入口与后续worker链的静态缺口变成真实PG证据，为终态契约裁决提供依据；本轮不替用户决定新付款/退款业务 |
| 角色/owner | Payment/Refund事实与Credit效果；Root唯一Billing文档writer/Git，billing_toolchain_hardening/Astra仅本地临时运行探针；数据审查员之后核证据 |
| 基线/文件 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，2a92260；Root只改当前任务板与必要CURRENT事实，调查员只写/tmp自有探针/日志，不改Billing/Git |
| 资源 | Root创建并安装一个随机独占PG database供探针使用；复用既有PG/Redis，不reset/新启共享服务，调查员关闭自身连接，Root正常drop自己的库 |
| 边界 | 实际createBillingRuntime HTTP身份/路由/receipt/SQL+生产worker过滤，不mock被测链；可经真实owner能力建立已fulfill付款基线，但须明确是fixture setup，不伪称HTTP自动fulfill |
| 独立工作 | Root同时核机器contract描述、入口消费者与可用查询能力；不写调查员临时文件，不复述已派调查 |
| 验证/交付 | HTTP结果、receipt/outbox/settlement/reversal/fulfillment/journal/余额每步前后值；worker真实领取返回与剩余Recorded事件；独占资源终态清理；不会把正好符合fact-only现状当作业务完成 |
| 未决 | 新major/原有数据处理、事实记录是否应该承诺自动Credit效果与未来终态查询；本轮保持v1/SQL原样，不加空handler/自动provider退款/按金额猜Credit |


### B8-D2b实跑与Root复验（2026-09-10）

调查员最终探针exit0（chunk8a2cf0，无遗留session），冻结目录`/tmp/billing-b8d2b-probe/`包含probe.mjs、run.log、results.json、summary.json、sha256.txt。
探针SHA256为6be4bfab0d25c9be111ba41e2cee0b28ceb06e98d9d5edf7dce74ed55f6c16af。前两版分别因探针统一ORDER BY引用不存在列、错误预期401而exit1；均在业务写入前关闭连接，保留first/second日志，不作为生产RED证据。
Root先执行`shasum -a 256 -c /tmp/billing-b8d2b-probe/sha256.txt`四项通过，再复制原脚本仅替换结果输出绝对路径，独立随机tenant/identity，不改测试步骤：
`DATABASE_URL=postgresql://nako@127.0.0.1:5432/billing_d2b_probe_5c2b1e6fd567401483e2 node --import tsx /tmp/billing-b8d2b-root-probe.mjs`。
Root chunk4d20ee正常exit0，日志`/tmp/billing-b8d2b-root-run.log`与`/tmp/billing-b8d2b-root-results.json`。

两次均实际createBillingRuntime、HTTP注入、service/admin-proxy认证、PG以及原scripts/process-payment-events.ts子进程；auth配置为jwks模式，但本次三路由不走用户JWT/JWKS验证，不声称实测JWKS网络。
没有mock被测业务链、Stripe网络或provider服务端退款；不把本地探针计作Stripe sandbox。

| 实际步骤 | Root与调查员一致结果 |
|---|---|
| 三入口错误凭据 | 3次403，tenant所有观察表零事实 |
| settlement接受1000 minor | settlement、succeeded receipt、PaymentSettlementRecorded各1，Credit account/grant/journal/fulfillment均0 |
| 原payment worker运行一次 | processed/retried/deadLettered/leaseLost均0，付款后SQL快照不变 |
| 显式调用owner fulfillSettlement建立fixture | account/grant/journal/fulfillment各1、available=1000000 micros；这是准备退款前置账务，不是HTTP自动效果，owner重放无重复 |
| internal proportional300与admin line_specific200 | reversal累计2/总额500 minor；receipt累计3；Credit余额/剩余grant保持1000000、journal仍1、fulfillment_reversal为0 |
| 每个HTTP首次+同key重放+同identity新key | 共9次202，业务结果相同、事实与余额不重复变化；未覆盖漂移payload等其他语义 |
| 原payment worker第二次 | 四项统计仍0，最终3条Recorded全部attempts0/published_at NULL/lease_token NULL |
| admin审计 | 仅1条admin_refund，reason=line_specific:local admin refund fact；不是行分配执行证据 |

每次15份SQL快照。Root子进程均exit0，runtime与Redis关闭，observer关闭前其他该库连接为空，observer随后end。
调查员明确停止访问后Root完成复验；Root查询pg_stat_activity为空，再通过dropdb正常删除自己创建的billing_d2b_probe_5c2b1e6fd567401483e2，查询pg_database计数0（chunkc4f336 exit0）。未FORCE/清空Redis/新启共享服务/操作他人库。

### B8-D2b契约与消费者静态交叉核查

Root解析当前canonical OpenAPI的实际ref，输出`/tmp/billing-b8d2b-contract-observations.json`（基线2a92260）：
- settlement必填body仅settlement_id/provider/external_payment_ref/amount_minor/currency，无Checkout/subject/program/Credit映射；202为Durable settlement acceptance result，响应仅settlement_id及accepted。
- 两个refund入口没有机器requestBody，202泛V1SuccessResponse描述accepted for processing；运行时另有strict refund schema，不能用17route路径一致声称字段/语义一致。
- 全部GET只有healthz、readyz、metrics、catalog、credit-account、credit-ledger、subscriptions；没有Checkout/付款/退款/operation终态查询。
- 运行时refund allocation_mode枚举proportional/line_specific但无行选择字段，handler只拼入reason，未调用reverseCredits；付款handler只recordSettlement，不调用fulfillSettlement。
- 原payment worker及其oldest-pending-age查询仅过滤PaymentProviderEventReceived；Recorded两类型生产者不在该消费过滤中。指标盲区为源码结论，本轮未实测Prometheus指标。
- 本地BFF/Agent/Scheduler/Web运行树检索未发现上述三accept路由/Recorded类型的消费者，Billing仍有定义/生产/验证；仅是检索范围结论，不证明仓外无消费者或没有现存真实账务。

这是事实记录与Credit效果之间未闭环的实证，不等同于已经裁决应自动fulfill/按比例reverse，更不是provider退款API完成。
后续B8-D2需区分record事实、外部退款请求与Credit冲正的owner、状态和事务；以明确业务映射及终态可查询契约替代泛202承诺。
本轮唯一写入集为本任务板和CURRENT，生产源码/测试/机器OpenAPI/canonical SQL/依赖不变；不借窄探针放行完整B8设计门或整仓迁移。

### B8-D2b-E放行与交付边界

数据审查billing_data_review/Astra复核冻结四hash及Root脚本仅输出路径不同，两轮结果一致，无使窄结论失效的P1/P2。
源码server.ts三record调用、worker两处provider-event过滤及OpenAPI与观察一致；审查员不接触基础设施，不把只读审查冒充重跑。
特别保留：provider事件处理器另有冲正调用，本结论不是“所有退款路径无效果”；不是外部HTTP部署、JWKS网络、Stripe sandbox或线上消费者验证。
Root在主工作树实际执行sql:check通过、contract:check 17routes通过、diff --check退出0（chunka7438d）；真实runtime探针12HTTP/15快照/2原worker断言通过，非测试套件计数。
本轮仅两份事实文档，未重跑format/lint/typecheck/build/全套unit与integration/catalog/Prisma/smoke/audit，原因是生产代码和机器源未变化；最近完整证据仍绑定8b55a57的665/158，不能移算为本轮完整验收。
Root负责本两文件提交，Goal继续active，后续owner仍Billing负责人/Root：完成尚余退款/订阅/终态设计、真实数据及major消费者决策，再推进生产Nest/Prisma切换。

## B8-D2c退款身份与账务边界设计卡

上一轮分类：进展。c160bfe6d4721a74d0420ce567e0d967aa0b2370提交付款/退款终态实证，干净HEAD SQL/17route验证退出0；B8仍未切换生产writer。

| 项目 | 本轮设计门 |
|---|---|
| 目标/优先级 | P0：收敛Refund渠道事实身份、状态与Credit冲正边界；不新增隐含退款/赠送积分商业政策 |
| 归属 | Refund唯一退款writer，Credit唯一积分writer；Root整体设计/文档/Git，billing_toolchain_hardening只读Stripe退款解析调查，冻结后数据/TS审查 |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，c160bfe，起始干净 |
| 文件集 | Root仅TECHNICAL_DESIGN、DATA_MODEL、API_CONTRACT、CURRENT和本唯一任务板；调查员仅读源码/官方文档，/tmp自有探针如确有必要；不访问PG/Redis/真实Stripe、不改Git |
| 目录/粒度 | 比较Refund内具名service/repository与PaymentEvents直接写退款/Credit；采用已有七模块Refund与Credit公开能力，不新增通用Saga模块或目录。本轮扩展原三设计文档，不建平行规范 |
| 数据/API | 现有35表映射为设计约束；先区分渠道refund ID与event ID、金额/状态、冲正执行结果和业务策略。机器v1/SQL保持原样，major/真实数据仍需确认 |
| 依赖/删除 | 依赖B8-D1/D2a事务和账户身份及D2b实证；实施时删除累计charge金额冒充单笔refund、latest退款推断、reason前缀冒充分配和退款直接写Credit。具体删除须实际源码证据 |
| 验证/交付 | 官方Refund/Event对象语义与当前实际SDK schema、现有账务冲正源码交叉核验；冻结设计双审，Root重跑SQL/contract/diff；未实施项不作通过声明 |


### B8-D2c实际解析证据与设计选择

billing_toolchain_hardening/Astra实际registry/provider+Stripe22.6.1 SDK签名探针16场景exit0（chunk87b498）；冻结/tmp/billing-b8d2c-refund/probe.mjs，SHA256
53ff21b35b0b8f2d0be8ba1c8cdca45a275cc720c02eca9753e910ee0832dd2e，同目录run.log/results.json/sha256.txt。
Root验证三hash通过，复制原脚本仅改结果输出绝对路径，执行`node --import tsx /tmp/billing-b8d2c-root-probe.mjs`（chunkd5dcba exit0）：
16场景、16正确签名、16错误secret拒绝，0网络请求。结果/tmp/billing-b8d2c-root-results.json，日志/tmp/billing-b8d2c-root-run.log。

实际当前parser把charge.refunded嵌套pending/requires_action/failed/canceled全部归refund_succeeded；refund.created/updated/failed原样无效果字段；
缺集合取charge.id+累计300，缺身份用unknown常量，非法金额回退累计，缺全部金额返回null，字符串minor“100”被转换10000；两条含has_more只输出首笔，关联/币种不匹配仍成功，缺metadata返回null Checkout。
这些是本地人工签名边界样本，不断言Stripe实际会生成异常shape。processor最新settlement选择/null全额/直接Credit查询为源码证据，本轮未连接数据库执行它。
Root核现有reverseCredits源码：先grant/后account、序号在account锁前、忽略target grant在途hold、delta<=0报错、历史效果依赖JOIN journal和当前渠道succeeded；这些静态事实纳入替代设计。
原比例integration标题带concurrent-safe但实际两个reverse调用为顺序，不移算并发通过。首次探索rg用了不存在credit文件/glob返回2，随后定位真实metering usage-settlement源；不是产品失败。

Root已将当前已批准单grant比例规则承接、严格渠道对象身份、T1 durable事实/T2原子Credit效果、零delta持久结果、held保护和失败回流review写入同三设计面。
不自行新增商户退款商业政策或删掉外部退款创建/订阅/行分配待办；major/真实数据依旧待确认。Refund.id/Stripe状态语义已2026-09-10通过官方Refund/Event/refunds文档核验，链接见TECHNICAL_DESIGN。
本轮未修改源码、测试、canonical SQL、机器contract、generated或依赖，Root唯一writer，审查只针对内部候选设计及冻结证据。


### B8-D2c首轮审查修正与数学核查

数据Astra提出1P2：zero delta与无条件exhausted review冲突；TS Sol提出1P1/2P2（包含同一zero项）：T1 root/effect混写、安全整数准入缺失。
Root接受并修改三设计面：ProviderEvents外层事务内observeProviderRefundEffect不再claim第二receipt，可信succeeded才可enqueue；record root无渠道证据则unknown/waiting_provider/零任务。
Stripe number先安全正整数校验，拒绝string/unsafe/fraction等，不在舍入后BigInt；delta>0才余额/可扣状态检查，本链冲正exhausted允许zero applied，expired/revoked保持review。
这些是明确内部契约与现有比例行为的修正，不授权当前v1/DDL切换。R2冻结后双审。

Root临时设计数学模型`python3 /tmp/billing-b8d2c-rounding-model.py`实际通过49140条小整数完整退款分拆序列、3个MAX_SAFE极值例、1/0/0以及其他grant有余额但source grant held不足的算术反例（chunkfcf382 exit0）。
模型SHA256 4863b2033effc61097c47d8f15cab55dc23f8466ba2adf28f55b693e75d97caf，结果/tmp/billing-b8d2c-rounding-model.json；它不是生产实现/PG并发测试，仅验证设计公式，不能宣称已修复运行时。
当前sql:check与contract:check17routes通过（chunkd9dccf）；SQL/OpenAPI仍与c160bfe字节一致。5文档之外无Billing修改，无基础设施清理需求。


### B8-D2c-R2内部放行与未完成项

数据Astra与TS Sol均复核/tmp/billing-b8d2c-design-r2-sha256.txt五hash，内部设计无剩余阻断P1/P2；Root仅追加本状态与标题/当前态，不改已审决策。
放行的三设计面绝对路径：
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md

Root主工作树实际16签名解析反例及49140条设计公式模型通过，SQL/17route/diff检查通过；生产源码/SQL/机器OpenAPI与起始c160bfe字节不变。
没有新数据库/Redis命名空间或网络server，调查员与Root均终态exit0；临时探针不触及真实provider或基础设施，无共享清理操作。
本轮未重跑完整format/lint/typecheck/test/build/integration/catalog/Prisma/smoke/audit，原因是仅五文档内部设计与本地只读解析调查；最近完整665/158仍绑定8b55a57，不转算为本提交验收。
未完成：已发现退款parser/冲正源码缺陷尚未修复；订阅/外部退款创建/行分配/补偿政策、完整机器major/真实数据/消费者决策、canonical Schema、Nest与Prisma生产writer切换，以及全套当前提交验收。
Root负责本五文档提交；下一阶段继续收敛Subscription实际invoice/payment/period身份与发放规则及必要业务决策，再完成总文档门实施，Goal保持完整active，不把本节放行当B8完成。

## B8-D2d订阅身份、周期与发放设计卡

上一轮分类：进展。9bab7da438524e82ca1608c942db6dcb4120c6c8提交退款内部R2设计，双审及干净HEAD SQL/17route通过；生产writer尚未迁移。

| 项目 | 本轮设计门 |
|---|---|
| 目标/优先级 | P0：订阅生命周期、账单结清证据、周期身份与Credit发放分离；确认现有商业规则来源，不凭active/trialing自行发放 |
| Owner/角色 | Subscription拥有订阅/period/term，Credit唯一写账；Root整体设计/文档/Git，billing_toolchain_hardening/Astra只读Stripe字段/事件调查，随后数据/TS审查 |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，9bab7da，起始干净 |
| 范围 | Root仅五既有文档TECHNICAL_DESIGN/DATA_MODEL/API_CONTRACT/CURRENT/本任务板；调查员仅源码/官方文档与/tmp本地签名探针，不碰PG/Redis/Stripe真实API/Git |
| 放置/粒度 | 比较Subscription模块编排Credit与PaymentEvents直接SQL发放，采用前者；既有三张subscription/period/term表按业务身份承接，不建invoice SDK类型业务层或空新模块 |
| 依赖/数据/API | 遵循D1/D2a/D2c账户namespace、事务、无环能力、不可变报价；核35表承接范围。暂不改canonical SQL/机器major，部署真实数据及商业新策略另确认 |
| 删除/验收 | 实施时移除metadata自报subject/最新offer重解释旧周期、subscription active直接触发Credit的无证据路径；具体删除依设计与合同测试。当前只通过官方语义/实际parser/源码和双审冻结，不冒称生产通过 |

### B8-D2d现状实证与候选设计

billing_toolchain_hardening/Astra在基线9bab7da用实际registry/provider+Stripe22.6.1 SDK签名执行12场景（chunk1e3800正常exit0），
冻结/tmp/billing-b8d2d-subscription/{probe.mjs,run.log,results.json,sha256.txt}；probe SHA256
 e2aed5bf78941697f28936fdff33fb1e69e87e38892b296ad624d2493b1b0108。
Root三hash校验通过，复制原脚本仅改结果输出路径，执行`node --import tsx /tmp/billing-b8d2d-root-probe.mjs`（chunkcf3795 exit0），
结果/tmp/billing-b8d2d-root-results.json、日志/tmp/billing-b8d2d-root-run.log：12场景/12正确签名/12错误secret拒绝。

metadata键由TS AST读取真实creator对象，结果checkoutId/tenantId/subjectId；没有实际调用或mock createSession，不能称完整Checkout创建链测试。
旧metadata与旧顶层周期active/trialing得到grantCredits=true（只是解析标志，没有执行积分写入）；creator metadata形状旧/现代都subscription=null；
现代single/multi items周期都null，混合旧顶层+multi items取旧顶层；invoice.paid/payment_succeeded/invoice_payment.paid及零额/站外结清样本全部原事件名+空effect。
processor静态为subscription_event_invalid、subscription_period_missing或ignored；没有PG/Redis/provider网络/HTTP server，不把本地签名样本称Stripe sandbox或实际到账。
Root初次定位用了错误stripe-checkout子目录/provider-event glob（探索命令exit1/2），随后按实际文件树定位；不是产品RED，不据此宣称缺实现。

Root核实旧processor按metadata.planId OR offer_key查latest published、以teamId覆盖subject、窗口key生成period并允许更新term.grant_micros；
旧SubscriptionGrant在重放查询前判断expiresAt>Date.now，GET subscription_id实际取term.id。这些是源码事实，不是本轮数据库复现。
三设计面候选分离生命周期/Invoice结清证据/period授权，沿单item单line现有Checkout profile，不查最新offer；现代line.period及InvoicePayment分配事实已官方核验。
新增商业政策问题已异步询问用户：是否统一账单结清后发放，试用/零额/手工结清单独明确。未获回复，不擅自用paid名称等同渠道实收或批准免费赠送；仅身份与执行机制可先内部审查。


### B8-D2d首轮审查与R2修正

数据Astra内部结构放行并提醒摘要不得含观察时间/Event ID、future等待不消耗重试；TS Sol提出2P2：future waiting/pending冲突及waiting_evidence缺无webhook恢复。
Root统一三设计面：T1明确waiting_period_start/pending/首次过期，waiting→pending CAS与T2同事务；临时分页网络失败不terminal inbox，有界重试；完整但未结清period由既有payment worker持久due扫描补查。
补查用period next_check/attempt/deadline短事务CAS、事务外GET及attempt/digest fence；候选每批20并发2、5分钟/12次/1小时，耗尽review/告警，新完整证据可解除预算类review；policy未批准不轮询/发放。
还冻结授权digest与变化证据digest分开，以及InvoicePayment账户scope身份/分配额而非PI总额。以上仍为实现前设计，不声称候选预算或新period列已验证。
Root执行当前sql:check、contract:check17routes、diff通过（chunk397e7e），src/test/database/contract/package/lock与9bab7da零差异。


### B8-D2d-R2局部内部放行与交付边界

数据Astra与TS Sol均核/tmp/billing-b8d2d-design-r2-sha256.txt五hash通过，无剩余内部结构阻断P1/P2；Root仅改标题/当前态及追加本验收说明，不新增未审设计。
三设计面：/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/TECHNICAL_DESIGN.md、
/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/DATA_MODEL.md、
/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing/docs/API_CONTRACT.md。
本轮主工作树12实际parser/SDK签名场景退出0、当前SQL/17route/diff通过（chunk6a9e1e），没有运行数据库或provider网络、没有基础设施资源待清理。
冻结实现仍为9bab7da源码/Schema/机器contract；全部修改只有五文档，Root唯一writer与提交负责人。
未运行完整format/lint/typecheck/test/build/integration/catalog/Prisma/smoke/audit，因本轮无生产源码/测试/依赖/机器源变化；最新完整665/158仍绑定8b55a57，不迁移其验收到本轮设计。
未完成：商业发放资格未确认，当前metadata/现代周期/active-trialing发放问题未修；真实数据及仓外v1消费者/major切换、外部退款创建、订阅退款/补偿与完整canonical/生产Nest-Prisma仍待闭环。
下一步Root核剩余总设计门和数据/契约决策，避免继续以单点设计代替生产切换；Goal保持原完整范围active。本轮有提交与改变行动依据的解析证据，不属于无进展或已完成。

## B8-G总切换门审计卡

上一轮分类：进展。1132906d70e6723dd65f1ece14621847659879f9提交订阅机制R2与12解析场景证据；机制局部放行，商业规则/整体切换仍待。

| 项目 | 本轮范围 |
|---|---|
| 目标 | 逐项核完整Goal与三设计门，形成唯一剩余实施顺序和必要用户决策，纠正任务板过时依赖/状态，不再把局部设计当整体完成 |
| Owner/角色 | Root唯一Billing文档writer/Git；billing_ts_review/Sol只读本地BFF/Web/Agent/Scheduler当前消费者与artifact证据；其余仓零写入 |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，1132906，起始干净 |
| 文件/放置 | Root只修改既有IMPLEMENTATION_PLAN/CURRENT，复用唯一计划而不新建任务中心；三设计/contract/schema/实现只读 |
| 独立工作 | Root核全Goal验收与批准/未批准边界、现有测试覆盖及迁移顺序；Sol核具体本地消费者调用/身份/header/artifact/测试，不由负检索推断仓外无人使用 |
| 禁区 | 不读连接秘密或探测真实账务库，不请求provider网络、不改Git remote状态、不修改其他owner/源码/SQL/机器契约/依赖 |
| 验证/交付 | 以实际当前文件/测试入口/生成与机器源为证据分类完成/未实现/待验/待决，Root交叉复核再提交两文档；商业与真实数据决策不凭空填默认值 |


### B8-G完整目标逐项审计（源码基线1132906）

本表是当前优先级与最终验收条件，纠正上方历史执行卡中的“下一阶段”字样；历史命令/commit证据原样保留。

| 原目标/必要门 | 当前权威证据与分类 | 进入最终验收还缺什么 |
|---|---|---|
| 35表完整catalog drift | B5/B6实现已验收；当前SQL SHA57b6ff…、generated provenance匹配同源，35表368列127约束83索引为最近真实安装证据 | 新canonical后对全部对象重跑真实fresh install/drift及故障反例，旧35数量不证明新字段通过 |
| SQL唯一源→只读Prisma生成 | scripts/prisma-generation、database/generated/schema.prisma/provenance与Client生成链存在；本轮offline generate通过 | 目标Schema再生/两次一致/反篡改/catalog与源码dist Client真实连接重验 |
| TypeScript规范与工具链 | B7实现；本轮format/lint/typecheck/build/SQL/17route全部通过 | 新业务代码同样门禁，不能因遗留bug放松typed/import规则 |
| 七个Nest feature及真实DI/lifecycle | package无@nestjs依赖，src/modules不存在，无NestFactory运行入口；未实现 | 固定稳定兼容Nest依赖、真实模块DAG/Provider图、源码及build HTTP/三个worker实例化/关闭验收 |
| Prisma唯一生产数据栈 | src（排除generated）无PrismaClient/adapter导入，bootstrap仍createPostgres服务；未实现 | 完整事务组改为Prisma；删除旧业务pg层/转发/重复SQL，不以装包或fixture证明生产切换 |
| Credit/Ledger唯一writer、事务/幂等 | D1设计/隔离Prisma能力通过，实际Refund/PaymentEvents仍直接碰Credit；未实现 | Credit公开能力承接acquisition/fulfillment/grant/hold/allocation/journal全组，嵌套rollback-only/tenant/锁序与竞态实际通过 |
| 目标SQL命名/UUID/账户namespace | D1 35表映射与D2a/c/d字段目标已审查，canonical仍原命名/VARCHAR | 完整canonical与contract身份所有权同时对齐；真实数据演进方式需事实确认 |
| Checkout事务外网络/unknown恢复 | D2a仅内部设计；原Promise.race/持锁网络仍在src | 有界真实取消、稳定身份、短事务claim/fenced finalize、持久恢复、迟到响应及UI相同intent重试闭环 |
| Payment/Refund现有链正确性 | S0仅一次性paid-only已修；D2b/c发现事实-only202、退款状态/金额/关联及held/zero delta问题 | 准确观察/明确任务handler/T2原子Credit与query结果；不是新增商户主动退款的同义词 |
| Subscription事实与Credit发放 | D2d机制通过，当前metadata/旧周期/active-trialing路径未修；商业资格待确认 | 可信Checkout+Invoice line周期/固定授权、批准政策、future/late/replay/recovery、真实PG/provider事件链 |
| Metering/execution并发 | UUID hold派生usage ID溢出未修；process-execution-events仍无跨进程lease的SELECT received循环 | D1 usage-hold绑定、receipt原子性、跨进程fence/有限重试/取消drain及两连接故障验证 |
| Reconciliation | 原repository/service与部分测试存在，scripts/bootstrap/interfaces未找到真实reconciliation入口 | 具名owner只读快照/orphan与不变量报告、可运行入口/有界周期触发、审计重试；不自动修账 |
| 数据权限/retention | canonical无GRANT/REVOKE/角色policy；docs有目标而无应用角色/清理执行证据 | 定义应用append-only与运维权限、保留/脱敏/GC允许集合和legal-hold保护；用独占角色/数据库验权限，不猜法定年限或自行删真实事实 |
| 新major及消费者artifact | 机器v1仍stable；BFF/Web手写投影无Billing immutable artifact pin；未实现 | B9a先决定/发布owner schema+version/commit/digest，再实际消费者固定并验证；不原位改stable v1或留长期alias |
| 最终完整验收 | 最近完整665/158绑定8b55a57；本轮只无DBverify，不能覆盖新运行时/集成 | 当前最终commit全门+真实PG/Redis+schema/Prisma+HTTP与worker smoke+适用BFF/Web消费者；CI16/镜像/provider sandbox等未实跑如实留缺口，不借文档宣称通过 |

### B8-G范围校正：既不缩小Goal，也不额外制造阻塞

完整原Goal必须做到现有Payment/Subscription/Checkout/Refund/Credit/Ledger/Metering/Reconciliation工程与真实行为收敛、owner消费者和可靠性闭环；上述未实现项不得删除或用当前Fastify/pg长期维持来结题。
但此前D2c/d交付说明把“外部退款创建、line-specific扩展、通用多item/proration/补偿政策”混列在未完成列表，容易被误读为所有这些新产品功能都是原Goal的前置条件。现明确区分：
- **必需**：现有退款接受/回调事实准确、已存在的比例Credit冲正完整；已经公开的allocation_mode含义应由major消除假承诺或实现真实已批准语义，不能静默接受后忽略。
- **需业务确认才新增**：主动调用provider创建退款、全新行项目模型、复杂订阅商品/赠送/补偿等。原Goal没有明确请求新增这些能力，本地4消费者也无主动退款用例证据；不擅自增加为结题门，不以新增功能无人决策阻塞既定工程目标。
- **仍真实待决**：现有订阅active/trialing行为将如何转成经账单证据支持的明确policy；不是仅升级框架可替用户决定的商业变更。已询问，未把拒发所有订阅当成完成。
本校正只消除自加要求，D2c/d为这些未来扩展保留的注意事项仍有效；不改变已审内部机制、不宣布未来扩展已实现或永不支持。

### B8-G本地消费者与跨仓切片证据

只读审查billing_ts_review/Sol；本地基线BFF26eec0112c83ea98aa045896d385c89ad88b45d2、Web0441603731f70e06b9f6b7860146baa654742c7b、Agent e24b4aab05ee6df811c21089effbe1f91d7c2f2c、Scheduler468700ff1f14a7b4f2a46b9e33b2eabfc291b08c。
Root独立读取以下相关代码/机器契约确认链路（chunkb6184f）：
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro/src/billing/pricing.ts:91-98 发起POST仅含content-type，没有稳定Idempotency-Key；同源adapter /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro/src/app/api/billing/checkout/route.ts:50 每次无header请求生成随机key，未知结果后重试会形成新的Checkout命令。后续需purchase intent稳定key，不按每次HTTP生成新身份。
- /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-bff/src/http/routes/owner.ts:166-219实际catalog/checkout路径；Checkout先拉Billing catalog，用plan.id构造offer_revision_id/amount_minor/currency/quote_snapshot并直接投影checkout_url。
- Billing机器checkout声明201，BFF owner.ts:219原样透传；/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-bff/contract/openapi/v1/openapi.yaml:1637只声明200。审查指出现测试double默认200未覆盖真实201；这是静态contract偏差，未声称本轮跨进程HTTP实跑。
- BFF identity/upstream将受信namespace映射tenant、user映射subject/actor并注入service/request credential；Web读取密封session，不能把body自报身份当接口迁移捷径。
- 未找到Billing contract repo/commit/digest生成client pin；BFF自有OpenAPI和Web历史generated provenance不证明它们消费了固定Billing artifact。
Agent/Scheduler在本次本地源码范围未找到实际Billing runtime client；Scheduler测试名billing.reconcile不是调用证据。无主动provider退款消费者。以上负检索不证明仓外无人使用或不存在真实收费，部署事实仍待用户确认。

### B8-G去循环的实际实施顺序

1. **B9a前置裁决**：确认真实数据/仓外v1消费者，批准新major切换及订阅policy；形成明确contract资源ID/命令identity/状态query/错误/幂等语义。当前B9“依赖B8”的粗表已纠正，不能B8等B9、B9又等B8。
2. **完整三设计门**：将已审D1/D2机制收敛成一致的机器canonical Schema与owner contract，补齐剩余应用权限/retention及Reconciliation运行设计；记录精确验证命令与当前commit。数据演进如涉及既有账务另立ADR，默认只在自建空库验证、不清真实库。
3. **Nest/Prisma生产切片**：重新核稳定兼容依赖，单一实现writer；先公共事务/配置/身份/错误/lifecycle，再按完整共享Credit事务组承接七业务能力及三个worker，不做pg/Prisma同事务拼接。依设计删除旧全局四层和转发/alias，未闭合中间commit不发布，不用fixture门冒称运行时切换。
4. **Owner验证后消费者串行切换**：Billing机器artifact先由owner固定version/commit/digest；BFF再固定并更新catalog/Checkout/必要query投影及201语义，Web固定BFF形状与稳定purchase intent。各仓按自己的AGENTS/已有writer状态派发，Root不抢写；没有真实Agent/Scheduler消费者就不编造client修改。
5. **最终集成放行**：主工作树重跑全部门禁、真实服务/worker恢复与消费者集成；所有失败/skip与真实provider/镜像/部署证据分层报告。完成须是实际目标Nest+Prisma代码，不是当前绿灯或设计目录齐全。

### B8-G当前本地执行证据

Root在主工作树执行`env -u DATABASE_URL -u SCHEMA_ADMIN_URL -u REDIS_URL -u REDIS_TEST_URL pnpm verify`，session57992终态exit0（chunkd2b780），日志/tmp/billing-bg-local-verify.log。
format:check、lint、typecheck、build、SQL、17route契约、offline Prisma Client生成均通过；Vitest29文件507通过、33文件158跳过、0失败，11.84s。
158集成跳过是刻意未提供真实基础设施环境，不作为完整test/integration通过；日志127.0.0.1:1 Redis拒绝来自失败路径测试，进程退出0，无共享基础设施变更。
本轮未运行真实db:apply-schema/db:verify-schema/prisma:check/test:integration、source/dist网络smoke、provider sandbox、CI16/镜像/DR；最近相关全套证据仍绑定8b55a57，不转算给新设计。
Root对src/test/database/contract/package/lock做当前1132906零差异检查，生成与dist为ignored构建产物，最终提交只两文档。Root SQL手册/Agent gitlink/.tmp原有改动保持不变。

### B8-G审查结论与立即可推进项

数据Astra复核/tmp/billing-bg-audit-sha256.txt两hash、Goal范围及507/158日志，审计放行；无整体完成声明。普通新major方向已另外异步询问用户，未获批准即不切换；不是清库授权。
审查指出不能让全部必要工作空等B9a：既有outbox decode绕过重试/死信、pricing不同key revision竞争均有真实缺陷证据，不涉及新商业规则/资源ID/API breaking。
因此Root继续按§8.1局部修复门推进这两项必要可靠性修复，先outbox；保持完整Goal，局部修复不替代Nest/Prisma最终迁移。重写的硬前置与已存在代码的独立纠错分开。

## B8-S1 Outbox损坏载荷局部修复卡

归属与设计：既有OutboxWorker消费基础设施，把已领取行的严格payload解码纳入现有try/catch/finally，复用有fence的retry/dead-letter，不改变API、表、handler contract或业务语义。保留对象schema，不把坏JSON当{}或空ack。此局部修复遵循Root §8.1例外，不授权完整业务目录重写。

| 项目 | 本次切片 |
|---|---|
| 目标/优先级 | P1：被现有parser拒绝的持久JSONB载荷进入有限重试/死信，不再无限重领；好事件保持正常消费 |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing，codex/billing-ts-prisma-alignment，0fd6a6cd372143f42a0eaed49d266afccecbc64a；起始源码干净，仅Root本卡 |
| 角色 | billing_toolchain_hardening/Astra为唯一实现writer；Root在派发后停止本仓写入，负责资源/交接后Git与主工作树验收；数据/TS只读审查 |
| 写入范围 | 只允许src/infrastructure/postgres/outbox-worker.ts和既有test/integration/outbox-worker.test.ts；不新建目录/文件、不改SQL/contract/deps/其他业务、文档由Root交接后修改 |
| 根因/方案 | decode在claim commit后、消费try之前抛错，fenced失败路径没被执行；移至受保护消费阶段，不取消schema校验。不扩成新的队列框架、不顺手重写整个lease生命周期 |
| TDD与行为 | 先真实PG RED，再最小GREEN；两outbox表的数组/scalar/JSON null坏载荷handler零调用，max1立即死信/lease清空/不再领取；max2第一次retry并next_attempt未来，第二次dead-letter、次数2、终态不重领；好对象仍发布 |
| 资源/隔离 | Root独占随机database并安装canonical，复用已有PG；只改/删本例随机tenant/outbox行，不触共享数据/Redis，不启动provider/server；worker关闭自己连接后交Root正常drop |
| 范围外 | attempt已耗尽但此前提交/ack丢失的业务恢复、完整renewal await/drain与Prisma writer切换仍在D1/B8；本切片不冒称这些已解决，不降低现有fence/预算 |
| 验证/交付 | worker记录RED/GREEN及lint/typecheck/format；冻结两代码hash后两位reviewer、Root目标integration和完整门。Root显式路径提交，不合入其他用户/Agent变化 |


### B8-S1交付与主控验收（源码基线0fd6a6c）

状态：实现 → 双审 → 主工作树完整验证已通过，由Root显式路径提交；最终交付SHA由本节所属提交定位，提交后再对干净HEAD复验。
- 唯一writer为billing_toolchain_hardening/Astra；实际修改仅outbox-worker.ts及既有integration文件，Root接管后更新本计划/CURRENT，无Schema、contract、依赖或业务handler变化。
- 原decode位于已提交claim与消费try之间，坏值抛出绕过重试/死信。本次移至既有try内，保持parser原语义及token条件更新；类型边界改为unknown，成功解析后才收窄为对象。
- 两表×五shape（数组、数字、布尔、普通字符串、JSON null）×max1/2共20反例，另加两合法对象正例；原三发布/handler失败/续租用例保留，并移除宽DELETE、改随机tenant filter。总计25项，比原来增加22项。
- max1死信清lease；max2第一次retry且next_attempt未来、未到期不领取，仅本例调due后第二次死信。两者均不调用坏payload handler、不发布，终态再poll不增加attempt；好对象原样发布。
- 保留边界：JSONB字符串内含可解析对象JSON时仍按原helper接受，本次不是禁止所有物理非object JSONB；续租在途await/drain、历史已提交效果/ack丢失与耗尽预算恢复仍待D1，Nest/Prisma完整目标保持未完成。

审查与TDD：
- Worker真实PG RED session88287 exit1，20失败/5通过，原因均为PersistedDataInvariantError逃出processOnce；GREEN25通过/0跳过。日志/tmp/billing-s1-red.log、/tmp/billing-s1-green-final.log。
- 数据Astra首审无阻断；TS Sol首审P2指出Row泛型虚假收窄，writer只改payload_json: unknown后Sol复核放行，无剩余P1/P2。Reviewer不操作数据库，运行证据由Root独立确认。
- 最终worker SHA256 6957b97acbef79b86c93deedf0ff014b14e9568f3b7ae556120829ffad78fd3e；integration SHA256 44cf40491a05db731ae7f8ad4dcb2ee5388ad774005eeabc26ed9ea85db957d5。

Root实际命令与结果：
- 独立目标实跑`pnpm exec vitest run test/integration/outbox-worker.test.ts`，session44956 exit0，1文件25通过、0失败0跳过；/tmp/billing-s1-root-target.log。
- P2前完整session87438 exit0，/tmp/billing-b8s1-root.5wBzQg；P2后最终冻结树完整session66598 exit0（chunk3b8efb），/tmp/billing-b8s1-root.myAw7I。两轮均由Root执行/tmp/billing-b8s1-root-verify.sh，结果687全套/180集成，0失败0跳过；下述为最终轮，旧轮不替代最终轮。
- Node24.20.0/pnpm11.25.0；`pnpm install --frozen-lockfile`、`pnpm db:apply-schema`、`pnpm verify`（format/lint/typecheck/build/sql/17route/test）均exit0；62文件687测试通过；独立`pnpm test:integration`33文件180通过。
- `pnpm db:verify-schema`差异[]，35表368列127约束83索引；`pnpm prisma:check`通过，canonical/OpenAPI hash仍57b6ff…/58fbe4…；`pnpm audit --json`五级漏洞均0；`git diff --check`通过。
- /tmp/billing-b8s1-root-smoke.py在自建空库分别启动真实源码与dist HTTP：health200、ready200、未认证401、可信BFF catalog200/request ID匹配、SIGTERM退出0。未启用provider，不冒称真实Stripe端到端。
- Worker库billing_s1_1f084cc5c2974b13a1ba在所有连接/进程终态后由Root正常drop；两轮Root库billing_accept_b8s1_476aa04c281c429fbfca与billing_accept_b8s1_8a3abd846c7b4658acf5由各自脚本正常drop，无FORCE/共享清理。库不存在检查见Root本轮工具证据。
- 未运行CI PostgreSQL16、镜像、provider sandbox、生产流量/灾备及新major消费者验收；本次不修改其他owner来清零历史门禁。Root其他用户/Agent变更保留。下一局部切片为pricing不同key并发revision竞争，尚未实施。


## B8-S2 Pricing发布并发修复卡

归属：Metering现有UsagePricingAdminService唯一发布writer；既有服务/集成文件局部修复，不改变职责/API/Schema，不新建目录或通用锁框架。方案经数据Astra与TS Sol只读核查，Root复核源码：首次发布没有aggregate行可锁，故不采用锁最新revision行或全表锁；采用tenant作用域事务advisory锁。此为必要一致性修复，不替代完整Nest/Prisma迁移。

| 项目 | 本切片裁决 |
|---|---|
| 目标/优先级 | P1：不同command key同tenant发布不再竞争MAX+1导致23505；receipt/rates/audit与revision保持原子性和成功重放 |
| 基线 | /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing；codex/billing-ts-prisma-alignment；c0ce201d4aa2825b2d4f5ec23e08caf532332cff；本仓原干净，只有Root本任务卡 |
| 执行与审查 | billing_toolchain_hardening/Astra唯一writer，Root派发后停止本仓写入；billing_data_review/Astra、billing_ts_review/Sol只读复核；Git及主工作树完整验收由Root串行负责 |
| 文件集 | 仅src/infrastructure/postgres/repositories/metering/usage-pricing-admin-service.ts、test/integration/usage-pricing-admin.test.ts；如必需越界先报告，不改connection公共框架/contract/schema/deps；Root交接后维护本计划/CURRENT |
| 锁/事务 | 原receipt claim/锁、digest及成功重放分支后，获取固定billing pricing namespace+tenant的事务advisory锁，再用独立SQL读取MAX；禁止把等待锁与MAX合成同一statement/CTE，禁止session锁/全局常量锁。保留UNIQUE最后防线与原原子事务 |
| 等待预算 | 仅advisory锁阶段设置transaction-local lock_timeout上限1000ms，已有更严格lock_timeout不放宽，statement_timeout原样保留；读取并保存原设置，成功获得锁即恢复；SQL失败直接原rollback，禁止aborted事务先补SQL。不得修改role/database/global/session默认设置 |
| 生命周期 | READ COMMITTED独立statement快照；若嵌套外层事务，xact锁持有至最外层commit，savepoint rollback恢复局部设置。此次不承诺REPEATABLE READ外层的无重试成功，不隐式改外层隔离级别；保留数据库冲突错误并回滚 |
| TDD | 两独立连接同tenant不同key先真实RED23505，再GREEN连续revision及两份完整rates/audit/receipt，各自成功重放；跨tenant不互阻；超时零半写、更严格预算不放宽；嵌套成功恢复原设置并持锁至outer commit、嵌套失败rollback后outer可继续 |
| 确定性 | 实际MAX结果后暂停A；旧实现B到MAX或新实现B被pg_locks证实等待后释放A。不能要求修复后B也先到MAX，所有gate finally释放、promise终态、短预算保证不挂测试；不伪造SQL/MAX结果 |
| 资源 | Root自建template0独占随机库、安装canonical，复用PG实例；仅本例随机tenant/ID，禁止共享清理/重启/Redis/provider网络；worker停止连接后Root正常drop |
| 验证交付 | Worker定向RED/GREEN、format/lint/tsc后冻结hash，不提交；双审及Root定向/全套真实PG、schema/Prisma、source/dist smoke/audit；Root显式4路径提交，任务外变更保留 |

SQL依据核验日期2026-09-10：[PostgreSQL18事务advisory锁](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS)、[READ COMMITTED快照](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED)、[lock_timeout](https://www.postgresql.org/docs/18/runtime-config-client.html)。1000ms是本切片工程预算，不是官方推荐或实测SLO；hash理论碰撞仅增加等待、不影响唯一性，不声称绝无碰撞。


### B8-S2实现、审查与主控验收

状态：唯一writer交付 → 数据Astra/TS Sol双审无阻断P1/P2 → Root主工作树完整验证通过，Root负责显式路径提交。范围仅当前READ COMMITTED发布竞争，不宣称整体B8完成。

- 生产新增23行：成功重放后保存lock_timeout原文本、仅将0或宽于1秒收紧至1000ms，以固定namespace+tenant取得事务advisory锁，立即恢复原值，再以独立statement读取MAX。全部新内建函数使用pg_catalog限定；不改原receipt、MAX、rates/audit及catch/rollback逻辑。
- 新增8项真实PG用例，共9项：原immutable/idempotent/quote保留；两连接同tenant真实竞争及完整两份revision/rates/receipt/audit和重放；跨tenant独立、嵌套成功预算恢复/outer commit前锁保留；receipt重放绕过竞争锁；0/2s/40ms lock_timeout及30ms更严格statement_timeout四组；RR旧snapshot冲突保留23505与回滚。
- RED session69279 exit1，6失败/3通过，真实23505约束uq_entitlement_usage_price_revision_site_number；/tmp/billing-s2-red.log。最终GREEN session30298 exit0，9通过/0跳过；/tmp/billing-s2-green-final.log。首轮typed lint发现Promise.withResolvers不在当前lib以及expect.any不安全赋值，已改普通gate/直接真实outcome断言，未放宽规则。
- 最终format/lint/tsc session45984 exit0；/tmp/billing-s2-gates-frozen.log。冻结service SHA256 75b71452c372410f23532625afb5c32939504b97de54f40b8f6a41d60d079ac8；test SHA256 b5e59aca637d6748a6344ce395517a70874e462b3eb7a4b8029759bdd687e46a。两审查员核hash与真实日志，未运行数据库，Root独立核验。
- Root定向`pnpm exec vitest run test/integration/usage-pricing-admin.test.ts`：session23186 exit0，9通过/0跳过，/tmp/billing-s2-root-target.log。Worker与Root连接全部退出后，Root正常drop billing_s2_ca2d6eb3dc574fde97a5，检查不存在。
- Root完整冻结树`/tmp/billing-b8s2-root-verify.sh` session47063 exit0（chunk757fcc），/tmp/billing-b8s2-root.icVXqK：frozen install、db:apply-schema、pnpm verify（format/lint/typecheck/build/SQL/17route/test）、test:integration、db:verify-schema、prisma:check、source/dist HTTP smoke、audit、diffcheck全部通过。
- 全套62文件695通过，独立integration33文件188通过，均0失败0跳过；catalog 35表368列127约束83索引且differences=[]，Prisma同源无漂移，audit五级漏洞均0。源码及dist health200/ready200/匿名401/BFF catalog200+request ID一致/SIGTERM退出0。
- 独占Root库billing_accept_b8s2_2a38729af8d549b2a7b7在全部命令终态后正常drop；不清共享Redis、不修改role/database默认设置、不触真实支付。两表SQL/OpenAPI hash仍57b6ff…/58fbe4…，依赖锁与生成provenance未变。
- 保留风险：1000ms只约束新增advisory等待，不是整个命令deadline；READ COMMITTED同tenant串行，hash碰撞可能额外等待；外层RR既有snapshot仍可23505，错误回滚而不假称自动成功。完整Nest/Prisma事务/worker生命周期、Checkout未知结果、退款/订阅实施和major消费者仍待B8/B9；CI16/镜像/真实provider sandbox未运行。
- S1提交c0ce201曾由Root干净HEAD完整复验：session7728 exit0，/tmp/billing-b8s1-root.uaeEB0，687全套/180集成及全门通过，库billing_accept_b8s1_c42ef1db5a864c068ae4已正常drop。本次S2证据不借历史结果替代。


## B8-D3 数据保护与Reconciliation设计门卡

前一Goal轮分类：progress，948034d已提交并经干净HEAD695/188及完整门验证。当前HEAD948034d8f75e4df77e814950cc33cbfe88cba515，本仓干净；完整Nest/Prisma未实现，不据局部绿灯结题。

| 项目 | 本轮范围 |
|---|---|
| Owner | Billing Root唯一文档writer与整体裁决；既有七业务owner保持，Reconciliation只调用具名owner能力，不取得账本writer |
| 当前事实 | 35表canonical无ACL/retention执行策略；reconciliation四类query/转发Service存在但无生产入口/一致快照/全关系orphan检查。实际代码与新目标分开记录 |
| 目标职责 | 在既有三设计面中补齐部署/运行时角色边界、不可变事实与删除保护、只读一致对账/有限扫描/显式重试路径；不新增收费/退款产品政策，不按猜测保留期删除数据 |
| 放置/粒度 | 比较新独立设计中心与扩展既有TECHNICAL_DESIGN/DATA_MODEL/SECURITY/API_CONTRACT；采用既有文档并由IMPLEMENTATION_PLAN/CURRENT索引，避免重复事实源。本轮不新增目录/Schema/HTTP入口 |
| 并行只读 | billing_data_review/Astra：35表写入与不可变事实/ACL/retention风险清单；billing_ts_review/Sol：实际reconciliation查询、调用与覆盖缺口/目标入口约束；Root：跨面方案、官方语义核验及自建PG权限能力探针 |
| 文件与权限 | 两审查员只读本仓src/test/database/docs及Root手册/CODEBASE_MAP，不写文件/Git/DB/服务；Root只改上述既有文档与任务板/CURRENT，脚本探针仅/tmp、自建临时库/NOLOGIN角色，完整所有权台账与清理 |
| 数据/API边界 | 不施加DDL/ACL到现有业务库、不请求provider、不读取真实账务，不改v1。真实数据/major/订阅商业资格仍待用户；内部权限/只读检查规则可先收敛。不自动repair、不新建通用配置中心 |
| 验证交付 | 用当前源码查询/写入/测试及官方PG语义核查设计；Root隔离角色探针验证权限可行性而非宣称生产实施。冻结文档双审，源码/schema/contract/deps零差异，执行适用门并显式提交文档 |


### B8-D3 当前证据与目标裁决

- 数据Astra按实际源码归类当前35表：12仅发现INSERT、21有状态/投影UPDATE、2无生产writer；未找到生产DELETE/TRUNCATE不是实际credential已禁止。目标D2退款/订阅状态变化单列，不把旧分类误作目标ACL。
- ACL实证改变实施顺序：PostgreSQL行锁需UPDATE，当前journal/settlement/acquisition/fulfillment等的FOR UPDATE与简单SELECT/INSERT授权冲突。因此选择完整事务迁移时承接并发保护，再施加ACL；不直接删锁，也不授无关列UPDATE冒称不可变。触发器方案暂不采用。
- TS Sol定位当前reconciler只有四顺序query，无outer snapshot、tenant可空、无界扫描；factory仅测试引用，package无运行入口，旧HTTP404有固定测试。漏双向orphan/多个owner关系，并把正常T1→T2等待粗判drift。目标改tenant必填、一致只读快照、各owner具名read能力、有界一次性CLI与显式周期Job，而不是恢复旧HTTP或新增万能服务。

Root实际权限探针：
- /tmp/billing-d3-acl/probe.mjs，SHA256 96a400d3b2c7faad293eaeb86e9f30266ab593cdead90047ba2b4b5fe55e8e28；run.log/results.json保留完整15项，chunkb33a49 exit0，7项允许/确认、8项预期42501均符合断言。
- 使用真实canonical安装后的独占库与3个本轮NOLOGIN角色，通过SET LOCAL ROLE测试对象权限；不是生产登录/membership或完整应用role兼容测试。当前nako只为自建资源管理员，不拿其权限模拟runtime。
- 自建库/角色准确台账在/tmp/billing-d3-acl/resources.json，连接全部关闭且观察为0后正常dropdb、逐个DROP ROLE，余项为空；cleanup.json及chunkf463d0。未执行FORCE、DROP OWNED、共享ACL修改或清Redis。

Root实际一致快照探针：
- /tmp/billing-d3-snapshot/probe.mjs，SHA256 8258b43cf3a7c2bf1a2a864ee6b7ff10b55b6ab18c62664d7e158c18e9faffa3；chunk9df1e4 exit0，results.json含两模式各before/during/after，共6份真实报告。
- 导入当前实际ReconciliationService与真实连接；wrapper只在首条真实account查询返回后插入独占fixture事务，不替换查询结果。故障fixture原本仅settlement缺fulfillment，原子切换后仅account余额错误，两侧始终有drift；当前autocommit组合返回ok。加外层READ ONLY REPEATABLE READ的候选调用返回旧snapshot的settlement drift，正确保持一致。
- 这是构造损坏状态的诊断反例，不声称正常收费命令制造了这两种状态；生产实现尚未修复。证明snapshot机制可行，不证明全orphan覆盖/分页/CLI/Prisma已完成。
- 自建库billing_d3_snap_ad503eaff73849b19898在两连接退出后正常drop，检查不存在；/tmp/billing-d3-snapshot/cleanup.log及chunk2eb6da。

设计放置：TECHNICAL_DESIGN负责角色/锁/owner/进程/预算；DATA_MODEL列当前35表与目标差异；SECURITY解释ACL事实及边界；API_CONTRACT定义未创建的CLI机器报告目标。首期preserve profile不新增自动删除/归档产品或法定年限；真实数据/新major/订阅资格仍待用户，内部设计不能替代批准。


### B8-D3内部审查与当前门禁

数据Astra/TS Sol核/tmp/billing-d3-design-sha256.txt六hash及实际probe，R1均无阻断P1/P2。Root补明确ON CONFLICT DO NOTHING非异常读取与23505/P2002整事务回滚，以及outer RR readonly设置必须在任何数据查询前、首个快照查询记录as_of；不扩大授权或宣称实现。
Root `env -u DATABASE_URL -u SCHEMA_ADMIN_URL -u REDIS_URL -u REDIS_TEST_URL pnpm verify` session53919 exit0（chunk21bfbc），/tmp/billing-d3-local-verify.log：format/lint/typecheck/build/SQL/17route/offline Prisma生成通过；29文件507测试通过、33文件188跳过、0失败。跳过为刻意无基础设施，不能算本轮全量integration通过；实际PG证据仅上述两个独占探针，最新完整695/188仍绑定948034d。
本轮src/test/database/contract/scripts/package/lock相对948034d零差异；仅六文档提交。未执行目标report schema验证（文件尚未创建）、生产ACL/CLI/全关系对账、Prisma生产迁移、provider sandbox/CI16/镜像/部署周期Job；全部保留为待实施/待验，完整三设计门仍未通过。资源清理已由Root验证，无遗留自建库/角色；Root其他用户/Agent改动未触及。


## B8-S3 当前对账一致快照修复卡

前一Goal轮为progress：a012f2d设计提交与两个真实PG探针改变实施判断。当前基线a012f2d89e17883b261bc35fd7aca877050e072b，本仓干净。归属既有Reconciliation查询服务；在原文件修复四次autocommit导致的false-ok，不新增模块/接口/Schema或自动repair。

| 项目 | 本切片边界 |
|---|---|
| 目标/优先级 | P1：四类检查读取同一只读RR快照，原四组判定与报告形状保持；Root上一轮真实before/during/after反例进入集成回归 |
| 执行/审查 | Root先定事务边界、数据Astra只读复核；billing_toolchain_hardening/Astra单一writer，Root派发后停止本仓写入；数据/TS只读最终审查，Git由Root |
| 文件集 | src/infrastructure/postgres/repositories/reconcile/reconciliation-service.ts、test/integration/reconciliation.test.ts；不改connection公共框架/port/factory/API/schema/deps，Root交接后更新CURRENT/任务板 |
| 事务选择 | 比较复用caller事务后SET隔离级别与独立snapshot operation context；选runWithBillingContext建立独立上下文，再以同一SqlConnection的withTransaction创建新事务，首先SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY。不修改caller已建立的隔离级别/写权限，报告只针对已提交事实，不把caller未提交写入当权威；同一connection pool借第二client且结束后归还 |
| 预算/错误 | snapshot内单statement上限2s、idle-in-transaction上限5s；保留report实际借到client已有更严格预算（不继承caller SET LOCAL），均transaction-local，不改role/database/session默认；错误直接rollback并释放连接，不返回ok。预算仅限制DB语句/idle，借连接仍受既有10s connectionTimeout，非完整CLI总deadline/分页/内存上限，不冒称D3全部实现 |
| 实现粒度 | 原四query/映射可提为私有readReport，public run只建立独立snapshot；禁止复制第二套查询、query fake、放宽类型或机械新增框架层 |
| TDD/验收 | 先真实autocommit false-ok RED（两状态始终drift的原子切换），再GREEN只见一个snapshot；保留原4测试；验证只读阻止注入写入、SQL/解析失败rollback后可复用、重复run新snapshot、pool size=2下caller/report backend PID不同，caller外层写事务成功/失败后均可继续读写/rollback且未提交写入不泄漏；report client更严格预算不放宽/caller local设置不变 |
| 资源 | Root自建template0独占随机库、安装canonical、复用PG实例；只改自有tenant/ID，不reset/shared Redis/provider；所有paused gate与SQL promise终态后Root正常drop |
| 范围外 | tenant必填CLI、新机器报告/coverage/incomplete、全owner orphan、pending效果分类、Prisma生产承接/部署Job均待D3/B8；本切片不恢复旧HTTP404或改变可选tenant旧方法签名 |
| 交付 | Worker RED/GREEN+format/lint/tsc后冻结两文件hash；Root定向与完整真实PG/Schema/Prisma/source-dist smoke/audit复验、双审后显式4路径提交 |

S3派前数据Astra只读放行：新ALS上下文隔离成立；pool>=2只保证单caller+report，并发caller占满pool仍可能等待到10s失败，保留为完整生命周期阶段风险；不可把caller SET LOCAL误称跨连接继承。


### S3必要前置扩大：连接FATAL事件生命周期

实施前实证发现：当前checked-out pg client没有error listener；给新snapshot设置idle预算可能把可回滚失败变成整个进程退出。Root使用/tmp/billing-s3-idle-probe.mjs导入真实connection.ts、自建空库，idle-in-tx50ms后等待200ms，得到Unhandled error / 25P03，子进程exit1（chunk472a04）；自建billing_s3_idle_03633d765f3c4ebca4bd无剩余连接并已正常drop。TS Sol核pg8.23源码：checkout移除Pool idle listener，Client在无active query时emit error；只给Pool监听或只catch Promise都不足。

不通过取消可靠性预算掩盖该缺陷。Writer已在RED12项（7失败5通过，/tmp/billing-s3-red.log）后停写，生产未改。Root授予下列附加范围后再续派：

| 项 | 扩大裁决 |
|---|---|
| Owner/职责 | 同一PostgresConnection资源生命周期；不是新业务owner/事务框架/协议 |
| 位置比较 | 把子进程事件测试塞入reconciliation.test.ts与独立connection测试；采用test/integration/postgres-connection.test.ts及postgres-connection.fixture.ts，使真实进程error事件/隔离资源负责一组变化原因，不让对账测试承载全部驱动诊断 |
| 写入集 | 原service+reconciliation.test.ts，增加src/infrastructure/postgres/connection.ts及上述两个测试文件，共5代码/测试文件；不改公共SqlConnection接口、依赖、Schema、其他业务writer；Root文档仍交接后维护 |
| 活跃client | checkout后BEGIN前安装自有非throw error listener，记录首个连接failure；后续query/execute/begin/commit对失效事务明确失败，不能回落到pool自动执行/误提交。listener清理精确移除本实例安装者，不removeAllListeners |
| 池与释放 | idle Pool也有非throw安全error listener；fatal或BEGIN/COMMIT/ROLLBACK连接失败的client销毁/带error release，不回收为健康client；正常路径release一次，context状态与监听在最终清理后释放 |
| 嵌套与错误 | fatal的外层事务在内层失败后仍失效，不能因savepoint cleanup删map而让后续SQL落入autocommit；嵌套finally逐层收敛，最外层释放。withTransaction保留原业务/SQL错误，rollback/release次级错误不得覆盖primary；不自动重试COMMIT或猜测提交结果 |
| 可观测 | 连接故障仅稳定service/operation/result/error_code结构化诊断，不输出SQL、URI、用户payload或完整驱动错误对象；非throw监听不等于吞掉业务失败，调用必须reject |
| 新TDD | 实际子进程先RED unhandled退出，再GREEN正常进程终态且run rejects；覆盖checked-out idle FATAL、Pool idle error、自有backend终止/替换、nested fatal后外层失败关闭、后续新client可用、JS原错保留及begin/commit/rollback清理。原对账与全仓事务用例不得删弱 |
| 资源 | 只终止本测试自己创建并记录PID的连接，验证datname为本独占库；子进程超时后只结束自己的process，await终态并关闭客户端；不动共享PG服务/其他PID/role/database默认 |

增加两个测试文件的门以本表为准；同仓仍由原writer独占，Root不抢写。新增子进程failure fixture是测试资源，不是新的运行时进程或常驻服务。完整Prisma/Nest替换及业务rollback-only收敛仍归B8，不用这次驱动加固冒称所有事务问题已解决。

### B8-S3冻结交付、双审与Root验收

状态：原writer五文件交付并停写 → 数据Astra/TS Sol分别核hash只读审查、无阻断P1/P2 → Root主工作树定向与完整门通过。Root负责两文档与七路径显式提交；本切片不是完整B8放行。

- 对账新增22行wrapper：新ALS上下文内withTransaction，先READ ONLY REPEATABLE READ，再transaction-local仅收紧2s statement/5s idle预算，原四条query/mapping移入private readReport而无复制。caller已提交事实才进入报告，caller写事务/SET LOCAL不受影响。
- 连接checkout在BEGIN前安装自身error listener并记录首failure，idle Pool也有非throw诊断；query/execute/control对poison失败关闭，嵌套rollback逐层减depth而不提前删外层map。最外层release一次，坏client销毁，交回驱动后精确off自身listener；withTransaction保留unknown/falsey primary，cleanup只安全诊断，不重试COMMIT。
- 对账RED /tmp/billing-s3-red.log：12项7失败5通过，真实原子状态切换中旧报告false-ok；连接RED /tmp/billing-s3-connection-red-final.log，chunk203359 exit1，3子进程真实25P03/57P01未处理error退出1。短等待首轮未观察到FATAL，不作为故障证据；500ms后真实FATAL确认。
- Writer冻结session20817 exit0，/tmp/billing-s3-frozen-gates.log：format/lint/typecheck、unit/architecture472、定向PG30（对账12/连接9/S2回归9）通过；独立9child session24123 exit0，/tmp/billing-s3-child-final.log。初轮readonly数组类型错误已修正，未放宽门禁。
- 冻结SHA256：connection.ts dac0b29a37d9309f741a9ccd599e79c874eb8f382d124bee8c4b712d5013b24d；reconciliation-service.ts 24fcfe4519b4e282f8d4034618bdc89c3e77abe64122e4be519e63b6dab53ab2；reconciliation.test.ts 4b8b2a69054d8b92a03d5e4cc78e408d5e908ac1bc2e8c424645f19923bd723d；postgres-connection.test.ts 059b82a06b0053a7f0e405e868f6b15293498a834978498f721202c5cc51ceb1；postgres-connection.fixture.ts 9e8aabc812b71e81d5b1ae63d954bca262b8ceca47154860ce421efcfe4b230c。两审查员与Root实查一致。
- Root定向`pnpm exec vitest run test/integration/reconciliation.test.ts test/integration/postgres-connection.test.ts test/integration/usage-pricing-admin.test.ts --no-file-parallelism`：session55593 exit0，30通过0跳过，/tmp/billing-s3-root-target.log。随后完整`/tmp/billing-b8s3-root-verify.sh`：session96340 exit0（chunkca4505），/tmp/billing-b8s3-root.zpIWXq。
- 完整门实际执行：frozen install、db:apply-schema、pnpm verify（format/lint/typecheck/build/sql:check/contract:check/test）、test:integration、db:verify-schema、prisma:check、源码/dist真实HTTP smoke、pnpm audit --json、git diff --check，均exit0。全套63文件712通过，独立integration34文件205通过，0失败0跳过；catalog35表368列127约束83索引、differences=[]；Prisma同源无漂移，audit五级漏洞均0；两种HTTP均health200/ready200/匿名401/可信BFF catalog200且request ID匹配/SIGTERM退出0。
- Worker自有库billing_s3_08982b93c6f74de29001全部child/Root定向命令终态后连接实查0，Root正常drop；全门自有库billing_accept_b8s3_65aa9594a8894f2b89aa正常drop。Root查询确认两库均不存在（chunk44e1c1）。没有FORCE、共享Redis清理、role/database默认修改、其他backend终止或真实provider操作。
- SQL SHA仍57b6ff2cd09de0835b2c608575dea74644163ab591e21fa477855476661920bd，OpenAPI仍58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63；依赖/lock/generated provenance未改。官方语义核验：[pg Pool错误与释放](https://node-postgres.com/apis/pool)、[PG客户端超时](https://www.postgresql.org/docs/current/runtime-config-client.html)，2026-09-10；实际本地pg8.23源码与PG18.4实证才是本切片执行依据。
- 边界：BEGIN/COMMIT/ROLLBACK测试在命令发送前终止自有backend，未证明COMMIT已发送后ACK丢失；JS scan错误是明确故障注入，不声称canonical bigint能保存非法文本。2s/5s不覆盖10s pool acquisition或完整事务/CLI deadline；普通非FATAL SQL被业务callback吞掉后COMMIT实际ROLLBACK的识别仍待完整rollback-only。D3全owner关系/tenant必填CLI/分页/incomplete、Nest/Prisma生产迁移、CI16/镜像/provider sandbox/真实消费者均未完成或未运行。后续owner为Billing原负责人，Root把关major与真实数据政策。
