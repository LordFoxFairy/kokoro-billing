# Billing runtime layout

Current Fastify/pg layout only, not a mandatory layering template. The Nest/Prisma target and cutover gates live in
`docs/TECHNICAL_DESIGN.md`, ADR-0003 and `docs/IMPLEMENTATION_PLAN.md`.

```text
domain/payment/services/       payment state transitions
application/payment/           settlement, provider events, provider ports
application/subscription/      subscription read use cases
application/checkout/          catalog and checkout use cases
application/refund/            refund/reversal commands
application/credit/            account, grant, hold, ledger and redeem use cases
application/metering/          pricing, admission and usage settlement
application/reconcile/         reconciliation and admin read models
infrastructure/postgres/       PostgreSQL pool, transactions and outbox adapter
infrastructure/redis/          coordination and short-lived key-presence hint adapter
infrastructure/providers/      payment provider adapters
interfaces/http/               versioned HTTP transport and runtime validation
bootstrap/                     composition root
```

Application use cases own orchestration and transaction boundaries. PostgreSQL/Redis/provider SDKs stay in infrastructure; wire DTOs stay at interfaces and generated contracts stay read-only.
