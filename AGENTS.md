# kokoro-billing 子仓 Agent 规范

@../AGENTS.md

本仓是 Billing owner，负责 payment、subscription、checkout、refund、credit、ledger、reconcile 和 billing receipt。规则已经明确时直接执行，不重复向用户确认。

- 本仓运行工具链固定于`.node-version`/package/lock；先切换Node24.20.0再使用pnpm11.25.0，engineStrict拒绝旧Node。
- 工程与数据规则以 Root 三份专项手册为准；本文件不另立语言/SQL 规则。
- 当前 API 由 `src/main.ts` / `src/app.module.ts` 装配唯一 Nest module graph，Fastify 仅作为 Nest adapter；已切换业务按能力聚合于 `src/modules/`。尚未切换的旧业务 worker/脚本仍有 pg 消费者，旧四层和 `ports/` 不是新实现模板。
- 当前与目标、唯一 writer、公开能力及 Prisma 选型见 `docs/TECHNICAL_DESIGN.md`、`docs/DATA_MODEL.md` 和 ADR-0003。
- 唯一 canonical source 仍是 `database/schema.sql`。Prisma schema 是从 SQL 安装的临时库生成的只读投影；生成 Client 已用于现役 Nest 业务模块，由 `PrismaService` 和 `TransactionService` 承接生命周期与事务，不代表尚未切换的旧 pg 业务已全部迁移。
- Billing 全部 HTTP operation 为 internal-owner；机器事实源仍为 `contract/openapi/v1/openapi.yaml`。既有 wire 差异和后续切换见 `docs/API_CONTRACT.md`。
- 唯一任务表是 `docs/IMPLEMENTATION_PLAN.md`；同仓单一 writer，主控管理共享 Git index/commit，审查员只读。
- 真实集成测试只对本轮创建的独立临时 database 执行；复用 PostgreSQL/Redis 实例，不清空共享数据。

完成前执行：

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm sql:check && pnpm contract:check
DATABASE_URL=<本任务创建的独立临时database> pnpm db:apply-schema
DATABASE_URL=<本任务创建的独立临时database> REDIS_TEST_URL=<共享实例的隔离测试命名空间> pnpm test:integration
```

完整Schema drift已交付；B6a增加`pnpm prisma:generate`及`SCHEMA_ADMIN_URL=<同实例管理连接> pnpm prisma:check`，
后者在生成完成后执行，不先refresh覆盖差异。`format:check`已接入`verify`首门；现役 Nest graph 的生命周期由现 runtime 测试覆盖，实际验收以本轮执行范围和依赖证据为准。未配置真实依赖时
`pnpm test` 会跳过 integration；必须在报告中列出 pass/fail/skip，不能把该结果当作完整验收。
