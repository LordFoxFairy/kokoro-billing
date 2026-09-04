import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BillingAdmissionService } from '../../src/application/metering/services/billing-admission-service.js';
import { createBillingConnection, type RowDataPacket, type SqlConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresBillingAdmissionService } from '../../src/infrastructure/postgres/create-postgres-services.js';
import { createBillingServer } from '../../src/interfaces/http/server.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

const requiredDatabaseUrl = (): string => {
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
  return databaseUrl;
};

const seedAdmission = async (
  connection: SqlConnection,
  tenantId: string,
  status: 'held' | 'captured' | 'released' = 'held',
): Promise<{ readonly admissionId: string; readonly invocationId: string; readonly executionId: string }> => {
  const admissionId = randomUUID();
  const invocationId = `invocation-${randomUUID()}`;
  const executionId = `execution-${randomUUID()}`;
  await connection.execute(
    `INSERT INTO entitlement_billing_admission
      (admission_id, tenant_id, billing_subject_kind, billing_subject_ref, payer_ref, feature_key, surface,
       invocation_id, execution_id, meter_kind, amount_micros, mode, status, hold_id, idempotency_key)
     VALUES ($1, $2, 'user', $3, $4, 'model.request', 'agent', $5, $6, 'model_invocation', 10, 'credit', $7, $8, $9)`,
    [admissionId, tenantId, `subject-${randomUUID()}`, `payer-${randomUUID()}`, invocationId, executionId, status, randomUUID(), `authorize-${randomUUID()}`],
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
    authorizeUsage: async () => ({ holdId: randomUUID(), allocations: [] }),
    settleUsage: async () => ({ settlementId: randomUUID(), capturedMicros: 10, releasedMicros: 0 }),
    releaseUsage: async (input: { readonly holdId: string }) => ({ holdId: input.holdId, releasedMicros: 10 }),
    ensureUsageEventForHold: async () => randomUUID(),
  };
  const admission = createPostgresBillingAdmissionService(connection, usage);
  const server = createBillingServer({
    checkout: { create: async () => { throw new Error('unused checkout'); } },
    usage: { expireExpiredHolds: async (input) => ({ batchId: input.batchId, expiredHoldIds: [] }) },
    settlement: { recordSettlement: async (input) => ({ settlementId: input.settlementId, accepted: true }) },
    reversal: { recordReversal: async () => 'unused-refund' },
    webhook: { accept: async () => ({ providerEventId: 'unused-event', processingStatus: 'received' as const }) },
    account: { getForSubject: async () => null },
    admission,
    auth: {
      user: async () => null,
      bff: async () => null,
      admin: async () => null,
      webhook: async () => false,
      internal: async (request) => {
        const requestedTenant = request.headers['x-kokoro-tenant-id'];
        const serviceId = request.headers['x-kokoro-service'];
        return typeof requestedTenant === 'string' && typeof serviceId === 'string'
          ? { tenantId: requestedTenant, serviceId }
          : null;
      },
    },
  });
  return { admission, connection, server, tenantId };
};

integration('admission and execution command receipts', () => {
  it('checks the capture receipt before a terminal admission replay', async () => {
    const harness = await createHarness();
    const seeded = await seedAdmission(harness.connection, harness.tenantId);
    const key = `capture-${randomUUID()}`;
    const headers = { 'x-kokoro-tenant-id': harness.tenantId, 'x-kokoro-service': 'agent', 'idempotency-key': key };
    const payload = {
      invocation_id: seeded.invocationId,
      execution_id: seeded.executionId,
      accepted_provider_ref: 'provider-operation-a',
      accepted_at: '2026-09-01T00:00:00.000Z',
      service_receipt: { digest: 'a' },
      receipt_schema_version: '1',
    };
    try {
      const first = await harness.server.inject({ method: 'POST', url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/capture`, headers, payload });
      const identityReplay = await harness.server.inject({
        method: 'POST',
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/capture`,
        headers: { ...headers, 'idempotency-key': `capture-alternate-${randomUUID()}` },
        payload,
      });
      const drift = await harness.server.inject({
        method: 'POST',
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/capture`,
        headers,
        payload: { ...payload, accepted_provider_ref: 'provider-operation-b', service_receipt: { digest: 'b' } },
      });

      expect(first.statusCode).toBe(200);
      expect(identityReplay.statusCode).toBe(200);
      expect(identityReplay.json().data).toEqual(first.json().data);
      expect(drift.statusCode).toBe(409);
      expect(drift.json().error.code).toBe('billing.idempotency_conflict');
      const [rows] = await harness.connection.query<(RowDataPacket & { command_identity: string; status: string })[]>(
        `SELECT command_identity, status
           FROM entitlement_billing_command_receipt
          WHERE tenant_id = $1 AND command_name = 'CaptureAdmission' AND idempotency_key = $2`,
        [harness.tenantId, key],
      );
      expect(rows).toEqual([{ command_identity: seeded.admissionId, status: 'succeeded' }]);
    } finally {
      await harness.server.close();
      await harness.connection.end();
    }
  });

  it('binds release invocation and service receipt to the durable digest', async () => {
    const harness = await createHarness();
    const seeded = await seedAdmission(harness.connection, harness.tenantId);
    const key = `release-${randomUUID()}`;
    const headers = { 'x-kokoro-tenant-id': harness.tenantId, 'x-kokoro-service': 'agent', 'idempotency-key': key };
    const payload = { invocation_id: seeded.invocationId, reason: 'execution.failed', service_receipt: { digest: 'a' } };
    try {
      const first = await harness.server.inject({ method: 'POST', url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/release`, headers, payload });
      const identityReplay = await harness.server.inject({
        method: 'POST',
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/release`,
        headers: { ...headers, 'idempotency-key': `release-alternate-${randomUUID()}` },
        payload,
      });
      const drift = await harness.server.inject({
        method: 'POST',
        url: `/v1/internal/entitlement/admissions/${seeded.admissionId}/release`,
        headers,
        payload: { ...payload, service_receipt: { digest: 'b' } },
      });

      expect(first.statusCode).toBe(200);
      expect(identityReplay.statusCode).toBe(200);
      expect(identityReplay.json().data).toEqual(first.json().data);
      expect(drift.statusCode).toBe(409);
      expect(drift.json().error.code).toBe('billing.idempotency_conflict');
    } finally {
      await harness.server.close();
      await harness.connection.end();
    }
  });

  it('uses event ID as command identity while binding the required HTTP key', async () => {
    const harness = await createHarness();
    const eventId = `event-${randomUUID()}`;
    const key = `event-key-${randomUUID()}`;
    const headers = { 'x-kokoro-tenant-id': harness.tenantId, 'x-kokoro-service': 'agent', 'idempotency-key': key };
    const payload = {
      event_id: eventId,
      event_type: 'execution.unknown',
      execution_id: `execution-${randomUUID()}`,
      invocation_id: `invocation-${randomUUID()}`,
      occurred_at: '2026-09-01T00:00:00.000Z',
      receipt_schema_version: '1',
    };
    try {
      const first = await harness.server.inject({ method: 'POST', url: '/v1/internal/billing/execution-events', headers, payload });
      const identityReplay = await harness.server.inject({
        method: 'POST',
        url: '/v1/internal/billing/execution-events',
        headers: { ...headers, 'idempotency-key': `event-alternate-${randomUUID()}` },
        payload,
      });
      const keyDrift = await harness.server.inject({
        method: 'POST',
        url: '/v1/internal/billing/execution-events',
        headers,
        payload: { ...payload, event_id: `event-${randomUUID()}`, execution_id: `execution-${randomUUID()}` },
      });

      expect(first.statusCode).toBe(202);
      expect(identityReplay.statusCode).toBe(202);
      expect(identityReplay.json().data).toEqual(first.json().data);
      expect(keyDrift.statusCode).toBe(409);
      expect(keyDrift.json().error.code).toBe('billing.idempotency_conflict');
      const [events] = await harness.connection.query<RowDataPacket[]>(
        'SELECT event_id FROM entitlement_execution_event WHERE tenant_id = $1',
        [harness.tenantId],
      );
      expect(events).toHaveLength(1);
    } finally {
      await harness.server.close();
      await harness.connection.end();
    }
  });
});
