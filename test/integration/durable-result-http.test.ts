import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresBillingSettlementService } from '../../src/infrastructure/postgres/create-postgres-services.js';
import { createBillingServer } from '../../src/interfaces/http/server.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

const requiredDatabaseUrl = (): string => {
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
  return databaseUrl;
};

integration('durable result HTTP invariants', () => {
  it('maps a corrupt PostgreSQL receipt result to a stable generic 500', async () => {
    const connection = await createBillingConnection(requiredDatabaseUrl());
    const settlement = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const idempotencyKey = `settlement-${randomUUID()}`;
    const payload = {
      settlement_id: randomUUID(),
      provider: 'stripe',
      external_payment_ref: `payment-${randomUUID()}`,
      amount_minor: '1000',
      currency: 'USD',
    };
    const headers = {
      'x-kokoro-tenant-id': tenantId,
      'x-kokoro-service': 'payment-worker',
      'idempotency-key': idempotencyKey,
    };
    const server = createBillingServer({
      checkout: { create: async () => { throw new Error('unused checkout'); } },
      usage: { expireExpiredHolds: async (input) => ({ batchId: input.batchId, expiredHoldIds: [] }) },
      settlement,
      reversal: { recordReversal: async () => 'unused-refund' },
      webhook: { accept: async () => ({ providerEventId: 'unused-event', processingStatus: 'received' as const }) },
      account: { getForSubject: async () => null },
      auth: {
        user: async () => null,
        bff: async () => null,
        admin: async () => null,
        webhook: async () => false,
        internal: async (request) => request.headers['x-kokoro-tenant-id'] === tenantId
          && request.headers['x-kokoro-service'] === 'payment-worker'
          ? { tenantId, serviceId: 'payment-worker' }
          : null,
      },
    });

    try {
      const first = await server.inject({ method: 'POST', url: '/v1/internal/payment/settlements/accept', headers, payload });
      expect(first.statusCode).toBe(202);
      await connection.execute(
        `UPDATE payment_command_receipt SET result_json = '{"accepted":false}'::jsonb
          WHERE tenant_id = $1 AND command_name = 'payment.settlement.accept' AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );

      const replay = await server.inject({ method: 'POST', url: '/v1/internal/payment/settlements/accept', headers, payload });
      expect(replay.statusCode).toBe(500);
      expect(replay.json()).toMatchObject({
        error: { code: 'billing.internal_error', message: 'internal billing error' },
        meta: { request_id: expect.any(String) },
      });
      expect(JSON.stringify(replay.json())).not.toContain('billing.command_result_invalid');
    } finally {
      await server.close();
      await connection.end();
    }
  });
});
