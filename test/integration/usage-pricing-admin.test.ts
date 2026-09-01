import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { UsagePricingAdminService } from '../../src/modules/metering/usage-pricing-admin-service.js';
import { UsagePricingService } from '../../src/modules/metering/usage-pricing-service.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('admin usage pricing revisions', () => {
  it('publishes an immutable revision, is idempotent, and serves quotes', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const admin = new UsagePricingAdminService(connection);
    const pricing = new UsagePricingService(connection);
    const siteId = randomUUID();
    const idempotencyKey = `pricing-publish-${randomUUID()}`;
    const input = {
      siteId,
      operatorId: 'operator-1',
      effectiveFrom: new Date(),
      reason: 'initial target pricing',
      idempotencyKey,
      rates: [{ featureKey: 'chat', labelKey: 'model-a', inputMicrosPerMillion: 2, outputMicrosPerMillion: 4, reservationMicros: 10 }],
    } as const;
    try {
      const first = await admin.publish(input);
      const replay = await admin.publish(input);
      expect(replay).toEqual(first);
      const quote = await pricing.quote({ siteId, featureKey: 'chat', labelKey: 'model-a', inputTokens: 1_000_000, outputTokens: 0 });
      expect(quote.pricingRevisionId).toBe(first.pricingRevisionId);
      expect(quote.amountMicros).toBe(2);
      expect(quote.reservationMicros).toBe(10);
      await expect(admin.publish({ ...input, rates: [{ ...input.rates[0], outputMicrosPerMillion: 5 }] })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });
});
