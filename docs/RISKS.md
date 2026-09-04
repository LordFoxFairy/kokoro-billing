# kokoro-billing 风险索引

| 风险 | 当前控制 | 未闭环项 |
|---|---|---|
| Provider webhook 伪造/重放 | provider signature、account-to-tenant mapping、event UNIQUE、payload hash、inbox/outbox | provider error/lag metric、replay operator tooling |
| Credit projection drift | 同事务 account/grant/hold/journal、条件 UPDATE、reconciliation query | continuous drift metric、audited repair command |
| Redis 故障 | hint/lease 非事实源，PostgreSQL row lock/receipt 收敛 | readiness 当前仍依赖 Redis，需演练 |
| Unknown execution/payment | 保留 unknown/hold/event/receipt，不猜测终态 | SLA、lag alert、并发-safe execution worker |
| 跨 tenant 访问 | trusted context、repository predicate、tenant-qualified JOIN、architecture test | PostgreSQL RLS/最小权限证据 |
| Contract drift | owner OpenAPI、metadata、route parity | 完整 body/response parity、historical breaking diff、machine provenance |
| 数据保留/灾难恢复 | durable PostgreSQL facts | retention、backup restore、RPO/RTO 与演练证据 |

详细边界与处置见 [`SECURITY.md`](SECURITY.md)、[`RELIABILITY.md`](RELIABILITY.md) 和
[`RUNBOOK.md`](RUNBOOK.md)。
