import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection, type RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresCheckoutService } from '../../src/infrastructure/postgres/create-postgres-services.js';
import { createBillingServer } from '../../src/interfaces/http/server.js';

const dataEnvelope = z.object({ data: z.record(z.string(), z.unknown()) });
const errorEnvelope = z.object({ error: z.record(z.string(), z.unknown()) });

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

const requiredDatabaseUrl = (): string => {
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
  return databaseUrl;
};

integration('checkout durable HTTP replay', () => {
  it('replays reordered canonical JSON after the offer is disabled and rejects payload drift', async () => {
    const connection = await createBillingConnection(requiredDatabaseUrl());
    const checkout = createPostgresCheckoutService(connection);
    const tenantId = randomUUID();
    const subjectId = `subject-${randomUUID()}`;
    const offerId = randomUUID();
    const revisionId = randomUUID();
    const idempotencyKey = `checkout-${randomUUID()}`;
    const server = createBillingServer({
      checkout: { create: (input) => checkout.create(input) },
      usage: { expireExpiredHolds: async (input) => Promise.resolve(({ batchId: input.batchId, expiredHoldIds: [] })) },
      settlement: { recordSettlement: async (input) => Promise.resolve(({ settlementId: input.settlementId, accepted: true })) },
      reversal: { recordReversal: async () => Promise.resolve('unused-refund') },
      webhook: { accept: async () => Promise.resolve(({ providerEventId: 'unused-event', processingStatus: 'received' as const })) },
      account: { getForSubject: async () => Promise.resolve(null) },
      auth: {
        user: async (request) => Promise.resolve(request.headers['x-kokoro-tenant-id'] === tenantId
          ? { tenantId, subjectId }
          : null),
        bff: async () => Promise.resolve(null),
        internal: async () => Promise.resolve(null),
        admin: async () => Promise.resolve(null),
        webhook: async () => Promise.resolve(false),
      },
    });
    const headers = { 'x-kokoro-tenant-id': tenantId, 'idempotency-key': idempotencyKey };
    const firstPayload = {
      offer_revision_id: revisionId,
      amount_minor: '1999',
      currency: 'USD',
      quote_snapshot: {
        key: 'pro',
        credit_micros: '1000',
        metadata: { region: 'global', display: { badge: 'popular', rank: 1 } },
        tiers: [{ name: 'base', amount: 1000 }, { amount: 2000, name: 'plus' }],
      },
    };

    try {
      await connection.execute(
        "INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'pro', 'active')",
        [offerId, tenantId],
      );
      await connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
         VALUES ($1, $2, $3, 1, 'Pro', 'USD', 1999, 1000, 'month', 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, offerId, tenantId],
      );

      const first = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers, payload: firstPayload });
      await connection.execute(
        "UPDATE entitlement_offer SET status = 'disabled' WHERE tenant_id = $1 AND offer_id = $2",
        [tenantId, offerId],
      );
      const reorderedReplay = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers,
        payload: {
          quote_snapshot: {
            tiers: [{ amount: 1000, name: 'base' }, { name: 'plus', amount: 2000 }],
            metadata: { display: { rank: 1, badge: 'popular' }, region: 'global' },
            credit_micros: '1000',
            key: 'pro',
          },
          currency: 'USD',
          amount_minor: '1999',
          offer_revision_id: revisionId,
        },
      });
      const drift = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers,
        payload: {
          ...firstPayload,
          quote_snapshot: { ...firstPayload.quote_snapshot, metadata: { region: 'changed' } },
        },
      });

      expect(first.statusCode).toBe(201);
      expect(reorderedReplay.statusCode).toBe(201);
      expect(dataEnvelope.parse(reorderedReplay.json<unknown>()).data.checkout_id).toBe(dataEnvelope.parse(first.json<unknown>()).data.checkout_id);
      expect(drift.statusCode).toBe(409);
      expect(errorEnvelope.parse(drift.json<unknown>()).error.code).toBe('billing.idempotency_conflict');
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT checkout_id FROM payment_checkout WHERE tenant_id = $1 AND idempotency_key = $2',
        [tenantId, idempotencyKey],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await server.close();
      await connection.end();
    }
  });
});
