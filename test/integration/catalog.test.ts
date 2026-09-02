import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { CatalogService } from '../../src/modules/catalog/catalog-service.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('entitlement catalog', () => {
  it('lists only published, active, non-deleted revisions for a site', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = new CatalogService(connection);
    const tenantId = randomUUID();
    const offerId = randomUUID();
    const publishedRevisionId = randomUUID();
    const latestRevisionId = randomUUID();
    const draftRevisionId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'pro', 'active')`,
        [offerId, tenantId],
      );
      await connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros,
           billing_interval, status, published_at)
         VALUES ($1, $2, $3, 1, 'Pro', 'USD', 1999, 1000000, 'month', 'published', CURRENT_TIMESTAMP(6)),
                ($4, $5, $6, 2, 'Pro+', 'USD', 2999, 2000000, 'month', 'published', CURRENT_TIMESTAMP(6)),
                ($7, $8, $9, 3, 'Pro Draft', 'USD', 3999, 3000000, 'month', 'draft', NULL)`,
        [publishedRevisionId, offerId, tenantId, latestRevisionId, offerId, tenantId, draftRevisionId, offerId, tenantId],
      );
      await expect(service.listSellable(tenantId)).resolves.toEqual([{
        id: latestRevisionId,
        key: 'pro',
        name: 'Pro+',
        currency: 'USD',
        amountMinor: '2999',
        creditMicros: '2000000',
        billingInterval: 'month',
      }]);
    } finally {
      await connection.execute('DELETE FROM entitlement_offer_revision WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_offer WHERE tenant_id = $1', [tenantId]);
      await connection.end();
    }
  });
});
