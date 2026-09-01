# kokoro-billing 运行说明

```bash
export DATABASE_URL=TARGET
export REDIS_URL=TARGET
pnpm db:migrate
pnpm start
```

默认 API 监听 `127.0.0.1:4245`。`GET /healthz` 为存活检查，`GET /readyz` 检查 PostgreSQL 和 Redis。
Payment 与 Entitlement/Credit 在本仓内分 bounded context；Credit 余额、Hold、Commit、Refund、Ledger 和
账务事实全部由 PostgreSQL 持久化，Redis 只做 lease、cache 和 idempotency hint。
