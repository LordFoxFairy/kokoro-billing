# kokoro-billing 子仓 Agent 规范

@../AGENTS.md

本仓是 Billing owner，负责 payment、subscription、checkout、refund、credit、ledger、reconcile 和 billing receipt。规则已经明确时直接执行，不重复向用户确认。

- 目录按 bounded context 组织；每个 context 内保持 `domain/application/infrastructure/interfaces`，禁止万能 `BillingService` 和跨模块 Repository。
- 账务事实只能由 application service 在明确事务中修改；payment 不直接写 credit ledger，Agent 只能调用 quote/hold/commit/release。
- V1 从当前业务事实重建唯一 canonical `database/schema.sql`；删除 38 个历史 migration、runner、旧 DTO、旧 endpoint、双写和 fallback。
- SQL 使用 PostgreSQL `$1, $2, ...` 参数绑定；禁止 `FOREIGN KEY`、`REFERENCES`；关系由 owner 校验、事务、锁、状态机和真实业务 UNIQUE/CHECK 维护。
- 时间使用 `TIMESTAMPTZ(3)` 和 RFC 3339 UTC；金额使用最小货币单位整数加 `currency_code`，ledger append-only。

完成前执行：

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm db:apply-schema
```
