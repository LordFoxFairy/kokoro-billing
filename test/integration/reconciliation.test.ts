import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import {
  createPostgresAdminGrantService,
  createPostgresBillingSettlementService,
  createPostgresReconciliationService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("billing reconciliation", () => {
  it("detects projection drift against grant and journal facts", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const accountId = randomUUID();
    try {
      await createPostgresAdminGrantService(connection).grant({
        tenantId,
        subjectId: randomUUID(),
        accountId,
        amountMicros: 10,
        programKey: "reconcile",
        operatorId: "operator-1",
        reason: "test",
        idempotencyKey: `reconcile-${randomUUID()}`,
      });
      const service = createPostgresReconciliationService(connection);
      expect((await service.run(tenantId)).status).toBe("ok");
      await connection.execute(
        "UPDATE entitlement_credit_account SET available_micros = available_micros + 1 WHERE credit_account_id = $1",
        [accountId],
      );
      const report = await service.run(tenantId);
      expect(report.status).toBe("drift");
      expect(report.accountDrifts).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it("detects held projection drift against active holds and allocations", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const holdId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id, available_micros, held_micros) VALUES ($1, $2, $3, 0, 10)`,
        [accountId, tenantId, `subject-${accountId}`],
      );
      await connection.execute(
        `INSERT INTO entitlement_credit_hold (credit_hold_id, tenant_id, credit_account_id, idempotency_key, requested_micros, expires_at) VALUES ($1, $2, $3, $4, 10, CURRENT_TIMESTAMP(3) + INTERVAL '5 minutes')`,
        [holdId, tenantId, accountId, `reconcile-hold-${holdId}`],
      );
      const report =
        await createPostgresReconciliationService(connection).run(tenantId);
      expect(report.status).toBe("drift");
      expect(report.accountDrifts[0]).toMatchObject({
        heldMicros: "10",
        activeHoldMicros: "10",
        activeAllocationMicros: "0",
      });
    } finally {
      await connection.execute(
        "DELETE FROM entitlement_credit_hold WHERE credit_hold_id = $1",
        [holdId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_account WHERE credit_account_id = $1",
        [accountId],
      );
      await connection.end();
    }
  });

  it("detects payment fulfillment gaps and failed provider events", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const providerEventId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO payment_settlement (settlement_id, tenant_id, provider, external_payment_ref, amount_minor, currency, status)
         VALUES ($1, $2, 'stripe', $3, 100, 'USD', 'succeeded')`,
        [settlementId, tenantId, `reconcile-payment-${settlementId}`],
      );
      await connection.execute(
        `INSERT INTO payment_provider_event
          (provider_event_id, tenant_id, provider, external_event_id, event_type, payload_json, payload_hash, signature_valid, processing_status, processing_attempts, last_error)
         VALUES ($1, $2, 'mock', $3, 'payment.succeeded', '{}', REPEAT('a', 64), true, 'failed', 2, 'temporary')`,
        [providerEventId, tenantId, `evt-${providerEventId}`],
      );
      const report =
        await createPostgresReconciliationService(connection).run(tenantId);
      expect(report.status).toBe("drift");
      expect(report.settlementDrifts).toHaveLength(1);
      expect(report.providerEventDrifts).toHaveLength(1);
    } finally {
      await connection.execute(
        "DELETE FROM payment_provider_event WHERE provider_event_id = $1",
        [providerEventId],
      );
      await connection.execute(
        "DELETE FROM payment_settlement WHERE settlement_id = $1",
        [settlementId],
      );
      await connection.end();
    }
  });

  it("detects a succeeded reversal without a committed fulfillment reversal", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const service = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const reversalId = randomUUID();
    const accountId = randomUUID();
    try {
      await service.recordSettlement({
        settlementId,
        tenantId,
        idempotencyKey: `settlement-${settlementId}`,
        externalPaymentRef: `reconcile-reversal-${settlementId}`,
        amountMinor: 100,
        currency: "USD",
      });
      await service.fulfillSettlement({
        settlementId,
        tenantId,
        accountId,
        subjectId: `subject-${accountId}`,
        programKey: "reconcile",
        grantMicros: 10,
      });
      await connection.execute(
        `INSERT INTO payment_reversal (reversal_id, tenant_id, settlement_id, provider, external_reversal_ref, amount_minor, reason, status)
         VALUES ($1, $2, $3, 'internal', $4, 100, 'customer_request', 'succeeded')`,
        [reversalId, tenantId, settlementId, `refund-${reversalId}`],
      );
      const report =
        await createPostgresReconciliationService(connection).run(tenantId);
      expect(report.reversalDrifts).toHaveLength(1);
      expect(report.reversalDrifts[0]).toMatchObject({
        reversalId,
        fulfillmentReversalId: null,
      });
    } finally {
      await connection.end();
    }
  });
});
