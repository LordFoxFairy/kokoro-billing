import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RowDataPacket } from "../../src/infrastructure/postgres/connection.js";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import {
  createPostgresProviderEventAdminService,
  createPostgresProviderEventInboxService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("provider webhook inbox", () => {
  it("stores a signed provider event once and returns the same fact on replay", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const service = createPostgresProviderEventInboxService(connection);
    const tenantId = randomUUID();
    const externalEventId = `evt-${randomUUID()}`;
    try {
      const input = {
        tenantId,
        provider: "mock",
        externalEventId,
        eventType: "payment.succeeded",
        rawPayload: { id: externalEventId, amount: 1000 },
        signatureValid: true,
      } as const;
      const first = await service.accept(input);
      const replay = await service.accept(input);
      expect(first.providerEventId).toBe(replay.providerEventId);
      expect(first.processingStatus).toBe("received");
      await connection.execute(
        `UPDATE payment_provider_event SET processing_status = 'processed' WHERE provider_event_id = $1`,
        [first.providerEventId],
      );
      const processedReplay = await service.accept(input);
      expect(processedReplay.processingStatus).toBe("processed");
      const [events] = await connection.query(
        "SELECT provider_event_id FROM payment_provider_event WHERE tenant_id = $1 AND external_event_id = $2",
        [tenantId, externalEventId],
      );
      const [outbox] = await connection.query(
        "SELECT outbox_id FROM payment_outbox WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_type = $3",
        [
          "provider_event",
          first.providerEventId,
          "PaymentProviderEventReceived",
        ],
      );
      expect(events).toHaveLength(1);
      expect(outbox).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it("rejects an event before persistence when the provider signature is invalid", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const service = createPostgresProviderEventInboxService(connection);
    await expect(
      service.accept({
        tenantId: randomUUID(),
        provider: "mock",
        externalEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        rawPayload: {},
        signatureValid: false,
      }),
    ).rejects.toThrow("billing.provider_signature");
    await connection.end();
  });

  it("rejects the same external event id with a different payload", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const service = createPostgresProviderEventInboxService(connection);
    const tenantId = randomUUID();
    const externalEventId = `evt-${randomUUID()}`;
    try {
      await service.accept({
        tenantId,
        provider: "mock",
        externalEventId,
        eventType: "payment.succeeded",
        rawPayload: { id: externalEventId, amount: 1000 },
        signatureValid: true,
      });
      await expect(
        service.accept({
          tenantId,
          provider: "mock",
          externalEventId,
          eventType: "payment.succeeded",
          rawPayload: { id: externalEventId, amount: 2000 },
          signatureValid: true,
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
    } finally {
      await connection.end();
    }
  });

  it("requeues a failed event with a durable audited command", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const inbox = createPostgresProviderEventInboxService(connection);
    const admin = createPostgresProviderEventAdminService(connection);
    const tenantId = randomUUID();
    try {
      const accepted = await inbox.accept({
        tenantId,
        provider: "mock",
        externalEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        rawPayload: { ok: true },
        signatureValid: true,
      });
      await connection.execute(
        `UPDATE payment_provider_event SET processing_status = 'failed', last_error = 'temporary' WHERE provider_event_id = $1`,
        [accepted.providerEventId],
      );
      const first = await admin.retry({
        tenantId,
        providerEventId: accepted.providerEventId,
        operatorId: "operator-1",
        reason: "provider timeout",
        idempotencyKey: `retry-${randomUUID()}`,
      });
      const replay = await admin.retry({
        tenantId,
        providerEventId: accepted.providerEventId,
        operatorId: "operator-1",
        reason: "provider timeout",
        idempotencyKey: assertDefined(
          (
            await connection.query<
              (RowDataPacket & { idempotency_key: string })[]
            >(
              "SELECT idempotency_key FROM payment_command_receipt WHERE tenant_id = $1 AND command_name = 'ProviderEventRetry'",
              [tenantId],
            )
          )[0][0],
        ).idempotency_key,
      });
      expect(first).toEqual({
        providerEventId: accepted.providerEventId,
        processingStatus: "received",
      });
      expect(replay).toEqual(first);
      const [outbox] = await connection.query<
        (RowDataPacket & { published_at: Date | null; attempts: number })[]
      >(
        "SELECT published_at, attempts FROM payment_outbox WHERE aggregate_type = 'provider_event' AND aggregate_id = $1",
        [accepted.providerEventId],
      );
      expect(outbox[0]?.published_at).toBeNull();
      expect(Number(outbox[0]?.attempts)).toBe(0);
      const [audit] = await connection.query(
        "SELECT audit_event_id FROM entitlement_audit_event WHERE tenant_id = $1 AND action = 'provider_event_retry'",
        [tenantId],
      );
      expect(audit).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it("lists only the current site and supports processing-status filtering", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const inbox = createPostgresProviderEventInboxService(connection);
    const admin = createPostgresProviderEventAdminService(connection);
    const tenantId = randomUUID();
    const otherSiteId = randomUUID();
    try {
      const failed = await inbox.accept({
        tenantId,
        provider: "mock",
        externalEventId: `evt-${randomUUID()}`,
        eventType: "payment.failed",
        rawPayload: { ok: false },
        signatureValid: true,
      });
      const failedAgain = await inbox.accept({
        tenantId,
        provider: "mock",
        externalEventId: `evt-${randomUUID()}`,
        eventType: "payment.failed",
        rawPayload: { ok: false },
        signatureValid: true,
      });
      await inbox.accept({
        tenantId,
        provider: "mock",
        externalEventId: `evt-${randomUUID()}`,
        eventType: "payment.succeeded",
        rawPayload: { ok: true },
        signatureValid: true,
      });
      await inbox.accept({
        tenantId: otherSiteId,
        provider: "mock",
        externalEventId: `evt-${randomUUID()}`,
        eventType: "payment.failed",
        rawPayload: { ok: false },
        signatureValid: true,
      });
      await connection.execute(
        `UPDATE payment_provider_event SET processing_status = 'failed', processing_attempts = 2, last_error = 'temporary' WHERE provider_event_id = $1`,
        [failed.providerEventId],
      );
      await connection.execute(
        `UPDATE payment_provider_event SET processing_status = 'failed', processing_attempts = 1, last_error = 'retryable' WHERE provider_event_id = $1`,
        [failedAgain.providerEventId],
      );

      const firstPage = await admin.list({
        tenantId,
        status: "failed",
        limit: 1,
      });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBeTruthy();
      const cursor = firstPage.nextCursor;
      if (cursor === undefined)
        throw new Error("expected provider event cursor");
      await expect(
        admin.list({
          tenantId: otherSiteId,
          status: "failed",
          limit: 10,
          cursor,
        }),
      ).rejects.toThrow("billing.invalid_cursor");
      await expect(
        admin.list({ tenantId, status: "received", limit: 10, cursor }),
      ).rejects.toThrow("billing.invalid_cursor");
      const result = await admin.list({
        tenantId,
        status: "failed",
        limit: 10,
        cursor,
      });
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeUndefined();
      expect(
        new Set([failed.providerEventId, failedAgain.providerEventId]),
      ).toContain(firstPage.items[0]?.providerEventId);
      expect(
        new Set([failed.providerEventId, failedAgain.providerEventId]),
      ).toContain(result.items[0]?.providerEventId);
      expect(result.items[0]?.providerEventId).not.toBe(
        firstPage.items[0]?.providerEventId,
      );
    } finally {
      await connection.end();
    }
  });
});
