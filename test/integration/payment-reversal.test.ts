import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import type { RowDataPacket } from "../../src/infrastructure/postgres/connection.js";
import {
  createPostgresBillingReversalService,
  createPostgresBillingSettlementService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("payment reversal to credit reversal", () => {
  it("reverses only the unconsumed grant amount exactly once", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const settlement = createPostgresBillingSettlementService(connection);
    const reversal = createPostgresBillingReversalService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const settlementId = randomUUID();
    const externalPaymentRef = `test-refund-${randomUUID()}`;
    try {
      await settlement.recordSettlement({
        settlementId,
        tenantId,
        idempotencyKey: `settlement-${settlementId}`,
        externalPaymentRef,
        amountMinor: 1000,
        currency: "USD",
      });
      await settlement.fulfillSettlement({
        settlementId,
        tenantId,
        accountId,
        subjectId: `subject-${accountId}`,
        programKey: "test-plan",
        grantMicros: 100,
      });
      const reversalId = await reversal.recordReversal({
        tenantId,
        settlementId,
        externalReversalRef: `refund-${randomUUID()}`,
        amountMinor: 500,
        reason: "customer_request",
        idempotencyKey: `refund-command-${randomUUID()}`,
      });
      const first = await reversal.reverseCredits({
        tenantId,
        reversalId,
        settlementId,
        accountId,
        amountMicros: 40,
      });
      const second = await reversal.reverseCredits({
        tenantId,
        reversalId,
        settlementId,
        accountId,
        amountMicros: 40,
      });

      expect(first).toEqual(second);
      const [accountRows] = await connection.query<
        (RowDataPacket & { available_micros: string })[]
      >(
        "SELECT available_micros FROM entitlement_credit_account WHERE credit_account_id = $1",
        [accountId],
      );
      const [grantRows] = await connection.query<
        (RowDataPacket & { remaining_micros: string })[]
      >(
        "SELECT remaining_micros FROM entitlement_credit_grant WHERE source_ref = $1",
        [settlementId],
      );
      const [journalRows] = await connection.query(
        "SELECT journal_id FROM entitlement_credit_journal WHERE source_ref = $1",
        [reversalId],
      );
      const [outboxRows] = await connection.query(
        "SELECT outbox_id FROM payment_outbox WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_type = $3",
        ["payment_reversal", reversalId, "PaymentReversalRecorded"],
      );
      expect(accountRows[0]?.available_micros).toBe("60");
      expect(grantRows[0]?.remaining_micros).toBe("60");
      expect(journalRows).toHaveLength(1);
      expect(outboxRows).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it("rejects a reversal replay with a changed financial payload", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const service = createPostgresBillingReversalService(connection);
    const settlementService =
      createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const externalRef = `test-conflict-refund-${randomUUID()}`;
    try {
      await settlementService.recordSettlement({
        settlementId,
        tenantId,
        idempotencyKey: `settlement-${settlementId}`,
        externalPaymentRef: `test-conflict-payment-${randomUUID()}`,
        amountMinor: 1000,
        currency: "USD",
      });
      const idempotencyKey = `refund-command-${randomUUID()}`;
      const first = await service.recordReversal({
        tenantId,
        settlementId,
        externalReversalRef: externalRef,
        amountMinor: 500,
        reason: "customer_request",
        idempotencyKey,
      });
      await expect(
        service.recordReversal({
          tenantId,
          settlementId,
          externalReversalRef: externalRef,
          amountMinor: 500,
          reason: "customer_request",
          idempotencyKey,
        }),
      ).resolves.toBe(first);
      await expect(
        service.recordReversal({
          tenantId,
          settlementId,
          externalReversalRef: externalRef,
          amountMinor: 500,
          reason: "customer_request",
          idempotencyKey: `replacement-key-${randomUUID()}`,
        }),
      ).resolves.toBe(first);
      await expect(
        service.recordReversal({
          tenantId,
          settlementId,
          externalReversalRef: externalRef,
          amountMinor: 501,
          reason: "customer_request",
          idempotencyKey,
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
    } finally {
      await connection.end();
    }
  });

  it("serializes concurrent retries from independent PostgreSQL connections", async () => {
    const firstConnection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const secondConnection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const settlement = createPostgresBillingSettlementService(firstConnection);
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const input = {
      tenantId,
      settlementId,
      externalReversalRef: `concurrent-refund-${randomUUID()}`,
      amountMinor: 500,
      reason: "customer_request",
      idempotencyKey: `refund-command-${randomUUID()}`,
    } as const;
    try {
      await settlement.recordSettlement({
        settlementId,
        tenantId,
        idempotencyKey: `settlement-${settlementId}`,
        externalPaymentRef: `concurrent-payment-${randomUUID()}`,
        amountMinor: 1000,
        currency: "USD",
      });
      const [first, second] = await Promise.all([
        createPostgresBillingReversalService(firstConnection).recordReversal(
          input,
        ),
        createPostgresBillingReversalService(secondConnection).recordReversal(
          input,
        ),
      ]);

      expect(first).toBe(second);
      const [reversals] = await firstConnection.query<RowDataPacket[]>(
        "SELECT reversal_id FROM payment_reversal WHERE tenant_id = $1 AND settlement_id = $2",
        [tenantId, settlementId],
      );
      const [receipts] = await firstConnection.query<RowDataPacket[]>(
        `SELECT receipt_id FROM payment_command_receipt
          WHERE tenant_id = $1 AND command_name = 'PaymentReversal' AND idempotency_key = $2`,
        [tenantId, input.idempotencyKey],
      );
      expect(reversals).toHaveLength(1);
      expect(receipts).toHaveLength(1);
    } finally {
      await firstConnection.end();
      await secondConnection.end();
    }
  });

  it("allocates concurrent-safe proportional provider partial refunds", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const settlement = createPostgresBillingSettlementService(connection);
    const reversal = createPostgresBillingReversalService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const settlementId = randomUUID();
    try {
      await settlement.recordSettlement({
        settlementId,
        tenantId,
        idempotencyKey: `settlement-${settlementId}`,
        externalPaymentRef: `partial-payment-${randomUUID()}`,
        amountMinor: 1000,
        currency: "USD",
      });
      await settlement.fulfillSettlement({
        settlementId,
        tenantId,
        accountId,
        subjectId: `subject-${accountId}`,
        programKey: "partial-plan",
        grantMicros: 100,
      });
      const firstId = await reversal.recordReversal({
        tenantId,
        settlementId,
        externalReversalRef: `partial-refund-1-${randomUUID()}`,
        amountMinor: 250,
        reason: "provider_refund",
        idempotencyKey: `partial-command-1-${randomUUID()}`,
      });
      const secondId = await reversal.recordReversal({
        tenantId,
        settlementId,
        externalReversalRef: `partial-refund-2-${randomUUID()}`,
        amountMinor: 250,
        reason: "provider_refund",
        idempotencyKey: `partial-command-2-${randomUUID()}`,
      });
      await reversal.reverseCredits({
        tenantId,
        reversalId: firstId,
        settlementId,
        accountId,
      });
      await reversal.reverseCredits({
        tenantId,
        reversalId: secondId,
        settlementId,
        accountId,
      });
      const [accountRows] = await connection.query<
        (RowDataPacket & { available_micros: string })[]
      >(
        "SELECT available_micros FROM entitlement_credit_account WHERE credit_account_id = $1",
        [accountId],
      );
      const [grantRows] = await connection.query<
        (RowDataPacket & { remaining_micros: string })[]
      >(
        "SELECT remaining_micros FROM entitlement_credit_grant WHERE source_ref = $1",
        [settlementId],
      );
      expect(accountRows[0]?.available_micros).toBe("50");
      expect(grantRows[0]?.remaining_micros).toBe("50");
    } finally {
      await connection.execute(
        "DELETE FROM entitlement_outbox WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_journal WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_fulfillment_reversal WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_grant WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_fulfillment WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_acquisition WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_account WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_reversal WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_settlement WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_outbox WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.end();
    }
  });
});
