# kokoro-billing 风险索引

| 风险 | 当前控制 | 未闭环项 |
|---|---|---|
| Provider webhook 伪造/重放 | production provider allow-list、精确 header/form-body signature、account-to-tenant mapping、event UNIQUE、payload hash、inbox/outbox | provider error/lag metric、replay operator tooling |
| Credit projection drift | 同事务 account/grant/hold/journal、条件 UPDATE、reconciliation query | continuous drift metric、audited repair command |
| Redis 故障 | key-presence marker/lease 非事实源；API/expiry fail-open；ready 报 degraded；规范化 command 与 PostgreSQL receipt/fact 裁决 | 同进程不自动 reconnect；production outage/restore 演练 |
| Unknown execution/payment | 保留 unknown/hold/event/receipt，不猜测终态 | SLA、lag alert、并发-safe execution worker |
| 跨 tenant 访问 | trusted context、repository predicate、tenant-qualified JOIN、architecture test | PostgreSQL RLS/最小权限证据 |
| Contract drift | owner OpenAPI、capture/release/settlement/expiry shape、execution 409、ready status、webhook matrix、metadata、route parity | 其余 body/response parity、historical breaking diff、machine provenance |
| 数据保留/灾难恢复 | durable PostgreSQL facts | retention、backup restore、RPO/RTO 与演练证据 |

详细边界与处置见 [`SECURITY.md`](SECURITY.md)、[`RELIABILITY.md`](RELIABILITY.md) 和
[`RUNBOOK.md`](RUNBOOK.md)。
