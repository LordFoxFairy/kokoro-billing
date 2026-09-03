import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresUsagePricingService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('usage pricing revisions', () => {
  it('quotes token usage from the active immutable revision and exposes reservation micros', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const revisionId = randomUUID();
    const rateId = randomUUID();
    const service = createPostgresUsagePricingService(connection);
    try {
      await connection.execute(
        `INSERT INTO entitlement_usage_price_revision
          (usage_price_revision_id, tenant_id, revision, effective_from, status, published_at)
         VALUES ($1, $2, 1, CURRENT_TIMESTAMP(3), 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, tenantId],
      );
      await connection.execute(
        `INSERT INTO entitlement_usage_price_rate
          (usage_price_rate_id, usage_price_revision_id, tenant_id, feature_key, label_key,
           input_micros_per_million, output_micros_per_million, reservation_micros)
         VALUES ($1, $2, $3, 'chat', 'pro', 1000000, 2000000, 500)`,
        [rateId, revisionId, tenantId],
      );
      await expect(service.quote({ tenantId, featureKey: 'chat', labelKey: 'pro', inputTokens: 1000, outputTokens: 2000 })).resolves.toMatchObject({
        pricingRevisionId: revisionId,
        amountMicros: 5000,
        reservationMicros: 500,
      });
      await connection.execute(
        `INSERT INTO entitlement_usage_price_rate
          (usage_price_rate_id, usage_price_revision_id, tenant_id, feature_key, label_key,
           input_micros_per_million, output_micros_per_million, reservation_micros)
         VALUES ($1, $2, $3, 'chat', 'micro', 1, 0, 1)`,
        [randomUUID(), revisionId, tenantId],
      );
      await expect(service.quote({ tenantId, featureKey: 'chat', labelKey: 'micro', inputTokens: 1, outputTokens: 0 })).resolves.toMatchObject({
        amountMicros: 1,
      });
    } finally {
      await connection.execute('DELETE FROM entitlement_usage_price_rate WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_usage_price_revision WHERE tenant_id = $1', [tenantId]);
      await connection.end();
    }
  });
});
