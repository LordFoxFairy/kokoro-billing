import { z } from "zod";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BillingAdmissionService } from "../../src/application/metering/services/billing-admission-service.js";
import {
  createBillingConnection,
  type RowDataPacket,
  type SqlConnection,
} from "../../src/infrastructure/postgres/connection.js";
import {
  createPostgresBillingAdmissionService,
  createPostgresBillingSettlementService,
  createPostgresUsageSettlementService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";
import { createBillingServer } from "../../src/interfaces/http/server.js";
import { createUsageHoldDatabaseFixture } from "./usage-hold-binding.fixture.js";

const dataEnvelope = z.object({ data: z.record(z.string(), z.unknown()) });
const errorEnvelope = z.object({ error: z.record(z.string(), z.unknown()) });

const databaseUrl = process.env.DATABASE_URL;
const adminUrl = process.env.SCHEMA_ADMIN_URL;
const integration = describe.skipIf(databaseUrl === undefined);

const requiredDatabaseUrl = (): string => {
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  return databaseUrl;
};

const seedAdmission = async (
  connection: SqlConnection,
  tenantId: string,
  status: "held" | "captured" | "released" = "held",
): Promise<{
  readonly admissionId: string;
  readonly invocationId: string;
  readonly executionId: string;
}> => {
  const admissionId = randomUUID();
  const invocationId = `invocation-${randomUUID()}`;
  const executionId = `execution-${randomUUID()}`;
  await connection.execute(
    `INSERT INTO entitlement_billing_admission
      (admission_id, tenant_id, billing_subject_kind, billing_subject_ref, payer_ref, feature_key, surface,
       invocation_id, execution_id, meter_kind, amount_micros, mode, status, hold_id, idempotency_key)
     VALUES ($1, $2, 'user', $3, $4, 'model.request', 'agent', $5, $6, 'model_invocation', 10, 'credit', $7, $8, $9)`,
    [
      admissionId,
      tenantId,
      `subject-${randomUUID()}`,
      `payer-${randomUUID()}`,
      invocationId,
      executionId,
      status,
      randomUUID(),
      `authorize-${randomUUID()}`,
    ],
  );
  return { admissionId, invocationId, executionId };
};

const createHarness = async (): Promise<{
  readonly admission: BillingAdmissionService;
  readonly connection: SqlConnection;
  readonly server: ReturnType<typeof createBillingServer>;
  readonly tenantId: string;
}> => {
  const connection = await createBillingConnection(requiredDatabaseUrl());
  const tenantId = randomUUID();
  const usage = {
    authorizeUsage: async () =>
      Promise.resolve({ holdId: randomUUID(), allocations: [] }),
    settleUsage: async () =>
      Promise.resolve({
        settlementId: randomUUID(),
        capturedMicros: 10,
        releasedMicros: 0,
      }),
    releaseUsage: async (input: { readonly holdId: string }) =>
      Promise.resolve({ holdId: input.holdId, releasedMicros: 10 }),
    ensureUsageEventForHold: async () => Promise.resolve(randomUUID()),
  };
  const admission = createPostgresBillingAdmissionService(connection, usage);
  const server = createBillingServer({
    checkout: {
      create: async () => {
        return Promise.reject(new Error("unused checkout"));
      },
    },
    usage: {
      expireExpiredHolds: async (input) =>
        Promise.resolve({ batchId: input.batchId, expiredHoldIds: [] }),
    },
    settlement: {
      recordSettlement: async (input) =>
        Promise.resolve({ settlementId: input.settlementId, accepted: true }),
    },
    reversal: { recordReversal: async () => Promise.resolve("unused-refund") },
    webhook: {
      accept: async () =>
        Promise.resolve({
          providerEventId: "unused-event",
          processingStatus: "received" as const,
        }),
    },
    account: { getForSubject: async () => Promise.resolve(null) },
    admission,
    auth: {
      user: async () => Promise.resolve(null),
      bff: async () => Promise.resolve(null),
      admin: async () => Promise.resolve(null),
      webhook: async () => Promise.resolve(false),
      internal: async (request) => {
        const requestedTenant = request.headers["x-kokoro-tenant-id"];
        const serviceId = request.headers["x-kokoro-service"];
        return Promise.resolve(
          typeof requestedTenant === "string" && typeof serviceId === "string"
            ? { tenantId: requestedTenant, serviceId }
            : null,
        );
      },
    },
  });
  return { admission, connection, server, tenantId };
};

integration("admission and execution command receipts", () => {
  it("checks the capture receipt before a terminal admission replay", async () => {
    const harness = await createHarness();
    const seeded = await seedAdmission(harness.connection, harness.tenantId);
    const key = `capture-${randomUUID()}`;
    const headers = {
      "x-kokoro-tenant-id": harness.tenantId,
      "x-kokoro-service": "agent",
      "idempotency-key": key,
    };
    const payload = {
      invocation_id: seeded.invocationId,
      execution_id: seeded.executionId,
      accepted_provider_ref: "provider-operation-a",
      accepted_at: "2026-09-01T00:00:00.000Z",
      service_receipt: { digest: "a" },
      receipt_schema_version: "1",
    };
    try {
      const first = await harness.server.inject({
        method: "POST",
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/capture`,
        headers,
        payload,
      });
      const identityReplay = await harness.server.inject({
        method: "POST",
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/capture`,
        headers: {
          ...headers,
          "idempotency-key": `capture-alternate-${randomUUID()}`,
        },
        payload,
      });
      const drift = await harness.server.inject({
        method: "POST",
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/capture`,
        headers,
        payload: {
          ...payload,
          accepted_provider_ref: "provider-operation-b",
          service_receipt: { digest: "b" },
        },
      });

      expect(first.statusCode).toBe(200);
      expect(identityReplay.statusCode).toBe(200);
      expect(dataEnvelope.parse(identityReplay.json<unknown>()).data).toEqual(
        dataEnvelope.parse(first.json<unknown>()).data,
      );
      expect(drift.statusCode).toBe(409);
      expect(errorEnvelope.parse(drift.json<unknown>()).error.code).toBe(
        "billing.idempotency_conflict",
      );
      const [rows] = await harness.connection.query<
        (RowDataPacket & { command_identity: string; status: string })[]
      >(
        `SELECT command_identity, status
           FROM entitlement_billing_command_receipt
          WHERE tenant_id = $1 AND command_name = 'CaptureAdmission' AND idempotency_key = $2`,
        [harness.tenantId, key],
      );
      expect(rows).toEqual([
        { command_identity: seeded.admissionId, status: "succeeded" },
      ]);
    } finally {
      await harness.server.close();
      await harness.connection.end();
    }
  });

  it("binds release invocation and service receipt to the durable digest", async () => {
    const harness = await createHarness();
    const seeded = await seedAdmission(harness.connection, harness.tenantId);
    const key = `release-${randomUUID()}`;
    const headers = {
      "x-kokoro-tenant-id": harness.tenantId,
      "x-kokoro-service": "agent",
      "idempotency-key": key,
    };
    const payload = {
      invocation_id: seeded.invocationId,
      reason: "execution.failed",
      service_receipt: { digest: "a" },
    };
    try {
      const first = await harness.server.inject({
        method: "POST",
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/release`,
        headers,
        payload,
      });
      const identityReplay = await harness.server.inject({
        method: "POST",
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/release`,
        headers: {
          ...headers,
          "idempotency-key": `release-alternate-${randomUUID()}`,
        },
        payload,
      });
      const drift = await harness.server.inject({
        method: "POST",
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/release`,
        headers,
        payload: { ...payload, service_receipt: { digest: "b" } },
      });

      expect(first.statusCode).toBe(200);
      expect(identityReplay.statusCode).toBe(200);
      expect(dataEnvelope.parse(identityReplay.json<unknown>()).data).toEqual(
        dataEnvelope.parse(first.json<unknown>()).data,
      );
      expect(drift.statusCode).toBe(409);
      expect(errorEnvelope.parse(drift.json<unknown>()).error.code).toBe(
        "billing.idempotency_conflict",
      );
    } finally {
      await harness.server.close();
      await harness.connection.end();
    }
  });

  it("uses event ID as command identity while binding the required HTTP key", async () => {
    const harness = await createHarness();
    const eventId = `event-${randomUUID()}`;
    const key = `event-key-${randomUUID()}`;
    const headers = {
      "x-kokoro-tenant-id": harness.tenantId,
      "x-kokoro-service": "agent",
      "idempotency-key": key,
    };
    const payload = {
      event_id: eventId,
      event_type: "execution.unknown",
      execution_id: `execution-${randomUUID()}`,
      invocation_id: `invocation-${randomUUID()}`,
      occurred_at: "2026-09-01T00:00:00.000Z",
      receipt_schema_version: "1",
    };
    try {
      const first = await harness.server.inject({
        method: "POST",
        url: "/v1/internal/billing/execution-events",
        headers,
        payload,
      });
      const identityReplay = await harness.server.inject({
        method: "POST",
        url: "/v1/internal/billing/execution-events",
        headers: {
          ...headers,
          "idempotency-key": `event-alternate-${randomUUID()}`,
        },
        payload,
      });
      const keyDrift = await harness.server.inject({
        method: "POST",
        url: "/v1/internal/billing/execution-events",
        headers,
        payload: {
          ...payload,
          event_id: `event-${randomUUID()}`,
          execution_id: `execution-${randomUUID()}`,
        },
      });

      expect(first.statusCode).toBe(202);
      expect(identityReplay.statusCode).toBe(202);
      expect(dataEnvelope.parse(identityReplay.json<unknown>()).data).toEqual(
        dataEnvelope.parse(first.json<unknown>()).data,
      );
      expect(keyDrift.statusCode).toBe(409);
      expect(errorEnvelope.parse(keyDrift.json<unknown>()).error.code).toBe(
        "billing.idempotency_conflict",
      );
      const [events] = await harness.connection.query<RowDataPacket[]>(
        "SELECT event_id FROM entitlement_execution_event WHERE tenant_id = $1",
        [harness.tenantId],
      );
      expect(events).toHaveLength(1);
    } finally {
      await harness.server.close();
      await harness.connection.end();
    }
  });
});

integration("execution receipt provider reference input types", () => {
  it.each([
    ["string", "provider-operation", true],
    ["null", null, true],
    ["missing", undefined, true],
    ["object", {}, false],
    ["array", [], false],
    ["boolean", true, false],
    ["number", 123, false],
  ] as const)(
    "validates %s before debit and capture receipt completion",
    async (_name, providerRef, valid) => {
      const connection = await createBillingConnection(requiredDatabaseUrl());
      const tenantId = randomUUID();
      const accountId = randomUUID();
      const settlementId = randomUUID();
      const usage = createPostgresUsageSettlementService(connection);
      const admission = createPostgresBillingAdmissionService(
        connection,
        usage,
      );
      try {
        const settlement = createPostgresBillingSettlementService(connection);
        await settlement.recordSettlement({
          tenantId,
          settlementId,
          idempotencyKey: randomUUID(),
          externalPaymentRef: randomUUID(),
          amountMinor: 100,
          currency: "USD",
        });
        await settlement.fulfillSettlement({
          tenantId,
          settlementId,
          accountId,
          subjectId: accountId,
          programKey: "typed-receipt",
          grantMicros: 100,
        });
        const hold = await usage.authorizeUsage({
          tenantId,
          accountId,
          idempotencyKey: randomUUID(),
          requestedMicros: 10,
          featureKey: "model.request",
        });
        const holdId = hold.holdId;
        const seeded = await seedAdmission(connection, tenantId);
        await connection.execute(
          "UPDATE entitlement_billing_admission SET hold_id = $1 WHERE tenant_id = $2 AND admission_id = $3",
          [holdId, tenantId, seeded.admissionId],
        );
        const eventId = randomUUID();
        await admission.recordExecutionEvent({
          tenantId,
          eventId,
          eventType: "execution.accepted",
          invocationId: seeded.invocationId,
          executionId: seeded.executionId,
          occurredAt: new Date("2026-09-08T12:00:00.000Z"),
          receiptSchemaVersion: "1",
          idempotencyKey: randomUUID(),
          receipt:
            providerRef === undefined
              ? {}
              : { provider_operation_ref: providerRef },
        });
        const captured = valid;
        if (valid) await admission.processExecutionEvent(tenantId, eventId);
        else
          await expect(
            admission.processExecutionEvent(tenantId, eventId),
          ).rejects.toThrow("billing.execution_receipt_invalid");
        const [accounts] = await connection.query<
          (RowDataPacket & { available_micros: string; held_micros: string })[]
        >(
          "SELECT available_micros, held_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND credit_account_id = $2",
          [tenantId, accountId],
        );
        expect(accounts).toEqual([
          { available_micros: "90", held_micros: captured ? "0" : "10" },
        ]);
        const [events] = await connection.query<
          (RowDataPacket & { status: string })[]
        >(
          "SELECT status FROM entitlement_execution_event WHERE tenant_id = $1 AND event_id = $2",
          [tenantId, eventId],
        );
        expect(events).toEqual([
          { status: captured ? "processed" : "received" },
        ]);
        const [admissions] = await connection.query<
          (RowDataPacket & {
            status: string;
            accepted_provider_ref: string | null;
          })[]
        >(
          "SELECT status, accepted_provider_ref FROM entitlement_billing_admission WHERE tenant_id = $1 AND admission_id = $2",
          [tenantId, seeded.admissionId],
        );
        expect(admissions).toEqual([
          {
            status: captured ? "captured" : "held",
            accepted_provider_ref: captured ? (providerRef ?? "event") : null,
          },
        ]);
        const [receipts] = await connection.query<
          (RowDataPacket & { status: string })[]
        >(
          "SELECT status FROM entitlement_billing_command_receipt WHERE tenant_id = $1 AND command_name = 'CaptureAdmission'",
          [tenantId],
        );
        expect(receipts).toEqual(captured ? [{ status: "succeeded" }] : []);
        const [journal] = await connection.query(
          "SELECT journal_id FROM entitlement_credit_journal WHERE tenant_id = $1",
          [tenantId],
        );
        expect(journal).toHaveLength(captured ? 2 : 1);
      } finally {
        await connection.end();
      }
    },
  );
});

integration("maximum-length invocation admission lifecycle", () => {
  it("creates, rolls back a late capture failure, replays capture, and releases using admission UUID keys", async () => {
    const fixture = await createUsageHoldDatabaseFixture(adminUrl ?? "");
    const connection = await createBillingConnection(fixture.url);
    const tenantId = randomUUID();
    const subjectId = `subject-${randomUUID()}`;
    const accountId = randomUUID();
    const invocationId = "i".repeat(255);
    const usage = createPostgresUsageSettlementService(connection);
    const admission = createPostgresBillingAdmissionService(connection, usage);
    try {
      const settlement = createPostgresBillingSettlementService(connection);
      const paymentId = randomUUID();
      await settlement.recordSettlement({
        tenantId,
        settlementId: paymentId,
        idempotencyKey: randomUUID(),
        externalPaymentRef: randomUUID(),
        amountMinor: 100,
        currency: "USD",
      });
      await settlement.fulfillSettlement({
        tenantId,
        settlementId: paymentId,
        accountId,
        subjectId,
        programKey: "long-invocation",
        grantMicros: 100,
      });
      const revisionId = randomUUID();
      await connection.execute(
        `INSERT INTO entitlement_usage_price_revision
          (usage_price_revision_id, tenant_id, revision, effective_from, status, published_at)
         VALUES ($1, $2, 1, CURRENT_TIMESTAMP - INTERVAL '1 minute', 'published', CURRENT_TIMESTAMP)`,
        [revisionId, tenantId],
      );
      await connection.execute(
        `INSERT INTO entitlement_usage_price_rate
          (usage_price_rate_id, usage_price_revision_id, tenant_id, feature_key, reservation_micros)
         VALUES ($1, $2, $3, 'model.request', 10)`,
        [randomUUID(), revisionId, tenantId],
      );
      const created = await admission.create({
        tenantId,
        billingSubject: { kind: "user", ref: subjectId },
        payerRef: subjectId,
        featureKey: "model.request",
        surface: "agent",
        invocationId,
        executionId: `execution-${randomUUID()}`,
        meterKind: "model_invocation",
        idempotencyKey: randomUUID(),
      });
      expect(created.status).toBe("held");
      await connection.execute(
        `CREATE FUNCTION fail_usage_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.aggregate_type = 'usage_settlement' THEN RAISE EXCEPTION 'injected tail failure'; END IF; RETURN NEW; END $$`,
      );
      await connection.execute(
        `CREATE TRIGGER fail_usage_outbox BEFORE INSERT ON entitlement_outbox
         FOR EACH ROW EXECUTE FUNCTION fail_usage_outbox()`,
      );
      const receipt = {
        invocationId,
        executionId: "",
        acceptedProviderRef: "provider-operation",
        acceptedAt: new Date("2026-09-01T00:00:00.000Z"),
        serviceReceipt: { digest: "long" },
        receiptSchemaVersion: "1",
      };
      const [stored] = await connection.query<
        (RowDataPacket & { execution_id: string })[]
      >(
        "SELECT execution_id FROM entitlement_billing_admission WHERE admission_id = $1",
        [created.admissionId],
      );
      receipt.executionId = String(stored[0]?.execution_id);
      const snapshot = async () =>
        connection.query<RowDataPacket[]>(
          `SELECT
            (SELECT row_to_json(a) FROM (SELECT available_micros, held_micros, generation FROM entitlement_credit_account WHERE credit_account_id = $2) a) account,
            (SELECT jsonb_agg(row_to_json(g) ORDER BY g.credit_grant_id) FROM (SELECT credit_grant_id, remaining_micros, status FROM entitlement_credit_grant WHERE tenant_id = $1 AND credit_account_id = $2) g) grants,
            (SELECT jsonb_agg(row_to_json(x) ORDER BY x.credit_grant_id) FROM (SELECT credit_grant_id, held_micros, captured_micros, released_micros FROM entitlement_credit_hold_allocation WHERE tenant_id = $1 AND credit_hold_id = $3) x) allocations,
            (SELECT status FROM entitlement_credit_hold WHERE tenant_id = $1 AND credit_hold_id = $3) hold_status,
            (SELECT jsonb_agg(row_to_json(j) ORDER BY j.journal_seq) FROM (SELECT journal_seq, entry_kind, amount_micros, source_kind, source_ref FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2) j) journals,
            (SELECT COUNT(*)::int FROM entitlement_usage_event WHERE tenant_id = $1) usage_count,
            (SELECT COUNT(*)::int FROM entitlement_usage_settlement WHERE tenant_id = $1) settlement_count,
            (SELECT COUNT(*)::int FROM entitlement_outbox WHERE tenant_id = $1) outbox_count,
            (SELECT status FROM entitlement_billing_admission WHERE tenant_id = $1 AND admission_id = $4) admission_status,
            (SELECT jsonb_agg(row_to_json(r) ORDER BY r.receipt_id) FROM (SELECT receipt_id, status, command_name FROM entitlement_billing_command_receipt WHERE tenant_id = $1) r) receipts`,
          [tenantId, accountId, created.holdId, created.admissionId],
        );
      const beforeFailure = await snapshot();
      try {
        await expect(
          admission.capture(
            tenantId,
            created.admissionId,
            receipt,
            randomUUID(),
          ),
        ).rejects.toThrow("injected tail failure");
      } finally {
        await connection.execute(
          "DROP TRIGGER fail_usage_outbox ON entitlement_outbox",
        );
        await connection.execute("DROP FUNCTION fail_usage_outbox()");
      }
      expect(await snapshot()).toEqual(beforeFailure);
      const captured = await admission.capture(
        tenantId,
        created.admissionId,
        receipt,
        randomUUID(),
      );
      const replay = await admission.capture(
        tenantId,
        created.admissionId,
        receipt,
        randomUUID(),
      );
      expect(replay).toEqual(captured);
      const [capturedState] = await connection.query<RowDataPacket[]>(
        `SELECT
          (SELECT COUNT(*)::int FROM entitlement_usage_event WHERE tenant_id = $1 AND credit_hold_id = $2) events,
          (SELECT COUNT(*)::int FROM entitlement_usage_settlement WHERE tenant_id = $1 AND credit_hold_id = $2) settlements,
          (SELECT COUNT(*)::int FROM entitlement_credit_journal WHERE tenant_id = $1 AND source_ref = $2 AND entry_kind = 'debit') debits,
          (SELECT COUNT(*)::int FROM entitlement_outbox WHERE tenant_id = $1 AND aggregate_type = 'usage_settlement') outbox,
          (SELECT COUNT(*)::int FROM entitlement_billing_command_receipt WHERE tenant_id = $1 AND status = 'processing') processing`,
        [tenantId, created.holdId],
      );
      expect(capturedState).toEqual([
        { events: 1, settlements: 1, debits: 1, outbox: 1, processing: 0 },
      ]);

      const releasedCreation = await admission.create({
        tenantId,
        billingSubject: { kind: "user", ref: subjectId },
        payerRef: subjectId,
        featureKey: "model.request",
        surface: "agent",
        invocationId: `r${"i".repeat(254)}`,
        executionId: `execution-${randomUUID()}`,
        meterKind: "model_invocation",
        idempotencyKey: randomUUID(),
      });
      await expect(
        admission.release({
          tenantId,
          admissionId: releasedCreation.admissionId,
          invocationId: `r${"i".repeat(254)}`,
          reason: "execution.failed",
          idempotencyKey: randomUUID(),
        }),
      ).resolves.toMatchObject({ status: "rejected" });
    } finally {
      await connection.end();
      await fixture.close();
    }
  });
});
