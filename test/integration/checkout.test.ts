import { assertDefined } from '../assert-defined.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresCheckoutService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('checkout quote snapshot', () => {
  it('creates one checkout and replays the same snapshot idempotently', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const service = createPostgresCheckoutService(connection);
    const tenantId = randomUUID();
    const offerId = randomUUID();
    const revisionId = randomUUID();
    const idempotencyKey = `checkout-${randomUUID()}`;
    const input = {
      tenantId,
      subjectId: randomUUID(),
      idempotencyKey,
      offerRevisionId: revisionId,
      amountMinor: 1999,
      currency: 'USD',
      quoteSnapshot: { key: 'pro', creditMicros: '1000' },
      expiresAt: new Date(Date.now() + 300_000),
    } as const;
    try {
      await connection.execute(`INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'pro', 'active')`, [offerId, tenantId]);
      await connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
         VALUES ($1, $2, $3, 1, 'Pro', 'USD', 1999, 1000, 'month', 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, offerId, tenantId],
      );
      const first = await service.create(input);
      // The HTTP layer computes a fresh expiry on every retry. Server-generated
      // expiry must not turn a valid idempotent replay into a payload conflict.
      const replay = await service.create({ ...input, expiresAt: new Date(Date.now() + 300_000) });
      expect(replay).toEqual(first);
      await expect(service.create({ ...input, amountMinor: 2000 })).rejects.toThrow('billing.idempotency_conflict');
      const [rows] = await connection.query('SELECT checkout_id FROM payment_checkout WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, idempotencyKey]);
      expect(rows).toHaveLength(1);
    } finally {
      await connection.execute('DELETE FROM payment_checkout WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_offer_revision WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_offer WHERE tenant_id = $1', [tenantId]);
      await connection.end();
    }
  });

  it('does not create a checkout from an expired quote', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const service = createPostgresCheckoutService(connection);
    await expect(service.create({
      tenantId: randomUUID(), subjectId: randomUUID(), idempotencyKey: `expired-${randomUUID()}`,
      offerRevisionId: randomUUID(), amountMinor: 100, currency: 'USD', quoteSnapshot: { key: 'starter', creditMicros: '1000' }, expiresAt: new Date(Date.now() - 1),
    })).rejects.toThrow('billing.quote_expired');
    await connection.end();
  });

  it('requires a current sellable offer before creating a checkout', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const service = createPostgresCheckoutService(connection);
    await expect(service.create({
      tenantId: randomUUID(), subjectId: randomUUID(), idempotencyKey: randomUUID(), offerRevisionId: randomUUID(),
      amountMinor: 100, currency: 'USD', quoteSnapshot: { key: 'starter', creditMicros: '1000' }, expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow('billing.offer_revision_not_sellable');
    await connection.end();
  });

  it('persists a hosted provider session and replays it without creating a second session', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const tenantId = randomUUID();
    const offerId = randomUUID();
    const revisionId = randomUUID();
    let calls = 0;
    try {
      await connection.execute(`INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'hosted', 'active')`, [offerId, tenantId]);
      await connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
         VALUES ($1, $2, $3, 1, 'Hosted', 'USD', 1200, 9000, 'once', 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, offerId, tenantId],
      );
      const service = createPostgresCheckoutService(connection, {
        hostedProvider: {
          provider: 'fake',
          createSession: async (input) => { calls += 1; return Promise.resolve({ provider: 'fake', sessionId: `session-${input.checkoutId}`, checkoutUrl: 'https://provider.example/checkout/session' }); },
        },
        publicBaseUrl: 'https://app.example',
      });
      const checkout = await service.create({ tenantId, subjectId: randomUUID(), idempotencyKey: randomUUID(), offerRevisionId: revisionId, amountMinor: 1200, currency: 'USD', quoteSnapshot: { key: 'hosted', creditMicros: '9000', name: 'Hosted' }, expiresAt: new Date(Date.now() + 60_000) });
      const first = await service.createHostedSession(tenantId, checkout.checkoutId);
      const second = await service.createHostedSession(tenantId, checkout.checkoutId);
      expect(first.checkoutUrl).toBe('https://provider.example/checkout/session');
      expect(second.checkoutUrl).toBe(first.checkoutUrl);
      expect(calls).toBe(1);
    } finally {
      await connection.execute('DELETE FROM payment_checkout WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_offer_revision WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_offer WHERE tenant_id = $1', [tenantId]);
      await connection.end();
    }
  });
});
