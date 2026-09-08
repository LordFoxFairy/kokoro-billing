# kokoro-billing 子仓 Agent 规范

@../AGENTS.md

本仓是 Billing owner，负责 payment、subscription、checkout、refund、credit、ledger、reconcile 和 billing receipt。规则已经明确时直接执行，不重复向用户确认。

- 本仓运行工具链固定于`.node-version`/package/lock；先切换Node24.20.0再使用pnpm11.25.0，engineStrict拒绝旧Node。
- 工程与数据规则以 Root 三份专项手册为准；本文件不另立语言/SQL 规则。
- 当前代码仍为 Fastify + pg 全局分层；目标按业务能力聚合 Nest modules。旧四层和 `ports/` 不是新实现模板。
- 当前与目标、唯一 writer、公开能力及 Prisma 选型见 `docs/TECHNICAL_DESIGN.md`、`docs/DATA_MODEL.md` 和 ADR-0003。
- 唯一 canonical source 仍是 `database/schema.sql`。Prisma 目标是从 SQL 安装的临时库生成只读 schema/Client；未完成生成、事务承接和完整数据门前不切换生产数据访问。
- Billing 全部 HTTP operation 为 internal-owner；机器事实源仍为 `contract/openapi/v1/openapi.yaml`。既有 wire 差异和后续切换见 `docs/API_CONTRACT.md`。
- 唯一任务表是 `docs/IMPLEMENTATION_PLAN.md`；同仓单一 writer，主控管理共享 Git index/commit，审查员只读。
- 真实集成测试只对本轮创建的独立临时 database 执行；复用 PostgreSQL/Redis 实例，不清空共享数据。

完成前执行：

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm sql:check && pnpm contract:check
DATABASE_URL=<本任务创建的独立临时database> pnpm db:apply-schema
DATABASE_URL=<本任务创建的独立临时database> REDIS_TEST_URL=<共享实例的隔离测试命名空间> pnpm test:integration
```

完整Schema drift已交付；B6a增加`pnpm prisma:generate`及`SCHEMA_ADMIN_URL=<同实例管理连接> pnpm prisma:check`，
后者在生成完成后执行，不先refresh覆盖差异。`format:check`与Nest生命周期门尚待任务板对应切片交付。未配置真实依赖时
`pnpm test` 会跳过 integration；必须在报告中列出 pass/fail/skip，不能把该结果当作完整验收。
