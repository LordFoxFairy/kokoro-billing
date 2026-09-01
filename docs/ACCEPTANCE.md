# kokoro-billing 验收

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm sql:check
pnpm contract:check
pnpm test
```

PostgreSQL/Redis 闭环：`DATABASE_URL=TARGET REDIS_TEST_URL=TARGET pnpm db:migrate`，再运行
`DATABASE_URL=TARGET REDIS_TEST_URL=TARGET pnpm test:integration -- --no-file-parallelism`。
验收覆盖支付、订阅、Credit grant/hold/commit/refund、账本、webhook inbox、幂等、重试、死信和恢复。
