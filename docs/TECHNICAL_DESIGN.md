# Billing Technical Design

Billing is one deployable modular monolith with Commerce, Payment and Entitlement/Credit modules. Credit remains an internal module; no Scheduler database or independent Credit repository is imported.

## Mutation rules

1. Validate the transport schema and authenticated tenant before calling an application service.
2. Use PostgreSQL command receipts and unique facts for idempotency; Redis is an optional hint only.
3. Keep provider/network calls outside a PostgreSQL transaction.
4. Lock facts in receipt → payment/admission → account/hold/grant → journal → outbox order.
5. Provider and execution events enter an inbox first. Unknown events are retained for replay/reconciliation.
6. Replays compare payload hashes. A different payload under the same tenant/command/key returns `billing.idempotency_conflict`.

All Billing relationships that point to another aggregate carry `tenant_id` in the PostgreSQL
foreign key. The `0038-complete-tenant-lineage` migration removes identifier-only foreign keys
and adds composite lineage constraints across Credit, Payment, Subscription, Checkout, Refund,
and redeem facts. Application predicates remain tenant-scoped as a second boundary.

## Credit invariants

`available = gross - held`; each hold has exactly one terminal outcome; capture and release are mutually exclusive; every journal entry is append-only; every grant is burned in the published allocation order; refund reversal creates an exposure fact when already-consumed credit cannot be reversed.

## Runtime units

- `billing-api`: Fastify HTTP and health/readiness/metrics.
- `payment-worker`: provider inbox/outbox processing.
- `entitlement-worker`: fulfillment, admission, credit and expiry commands.
- `reconciliation-worker`: drift detection and repair commands.
- `schema-job`: numbered PostgreSQL migrations.

The process entrypoint is [`../src/main.ts`](../src/main.ts). Scheduler is an external generic command caller and is not a Billing business dependency.
