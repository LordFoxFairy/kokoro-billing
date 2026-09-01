# kokoro-billing 风险

- Provider webhook 重放：inbox、payload hash、durable receipt 和 outbox 共同保证幂等。
- Credit projection drift：余额与 journal 在同一 PostgreSQL 事务内更新，reconcile 发现漂移并告警。
- Redis 故障：只影响快速路径和 lease；账务事实不降级到 Redis。
- 退款与履约跨上下文：保持在 Billing 内部事务/outbox 边界，不新增 Credit 独立仓库。
