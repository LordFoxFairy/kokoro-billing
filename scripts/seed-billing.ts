import { createHash, randomUUID } from 'node:crypto';
import type { RowDataPacket } from '../src/infrastructure/postgres/connection.js';
import { createBillingConnection } from '../src/infrastructure/postgres/connection.js';
import { type PublishCatalogPlanInput } from '../src/application/checkout/services/catalog-admin-service.js';
import { type UsagePriceRateInput } from '../src/application/metering/services/usage-pricing-admin-service.js';
import { createPostgresCatalogAdminService, createPostgresUsagePricingAdminService } from '../src/infrastructure/postgres/create-postgres-services.js';

type SeedDocument = {
  /** Canonical bootstrap document; tenantId is written to the tenant_id column. */
  readonly tenantId: string;
  readonly operatorId?: string;
  readonly reason?: string;
  readonly effectiveFrom?: string;
  readonly plans?: readonly Omit<PublishCatalogPlanInput, 'tenantId' | 'operatorId' | 'reason' | 'idempotencyKey'>[];
  readonly usagePrices?: readonly UsagePriceRateInput[];
  readonly providerAccounts?: readonly { provider: string; externalAccountRef: string; status?: 'active' | 'disabled' }[];
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (process.env.ALLOW_BILLING_SEED !== 'true') throw new Error('ALLOW_BILLING_SEED=true is required');
const raw = process.env.BILLING_SEED_JSON;
if (!raw) throw new Error('BILLING_SEED_JSON is required');

let seed: SeedDocument;
try { seed = JSON.parse(raw) as SeedDocument; } catch { throw new Error('BILLING_SEED_JSON must be valid JSON'); }
if (!seed.tenantId || typeof seed.tenantId !== 'string') throw new Error('BILLING_SEED_JSON.tenantId is required');
const tenantId = seed.tenantId;
const operatorId = seed.operatorId ?? 'billing-bootstrap';
const reason = seed.reason ?? 'initial billing bootstrap';
const connection = await createBillingConnection(databaseUrl);
const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24);

try {
  const catalog = createPostgresCatalogAdminService(connection);
  for (const account of seed.providerAccounts ?? []) {
    await connection.beginTransaction();
    try {
      await connection.execute(
        `INSERT INTO payment_provider_account
          (provider_account_id, tenant_id, provider, external_account_ref, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), tenantId, account.provider, account.externalAccountRef, account.status ?? 'active'],
      );
      const [existing] = await connection.execute<(RowDataPacket & { tenant_id: string })[]>(
        `SELECT tenant_id FROM payment_provider_account WHERE provider = $1 AND external_account_ref = $2 FOR UPDATE`,
        [account.provider, account.externalAccountRef],
      );
      if (existing[0]?.tenant_id !== tenantId) throw new Error(`provider account ${account.provider}/${account.externalAccountRef} is already bound to another tenant`);
      await connection.execute(
        `UPDATE payment_provider_account SET status = $1 WHERE provider = $2 AND external_account_ref = $3`,
        [account.status ?? 'active', account.provider, account.externalAccountRef],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
  for (const [index, plan] of (seed.plans ?? []).entries()) {
    const result = await catalog.publishPlan({ ...plan, tenantId, operatorId, reason, idempotencyKey: `bootstrap:catalog:${digest}:${index}` });
    console.log(JSON.stringify({ kind: 'plan', key: result.key, revisionId: result.id }));
  }
  if (seed.usagePrices && seed.usagePrices.length > 0) {
    const pricing = createPostgresUsagePricingAdminService(connection);
    const effectiveFrom = seed.effectiveFrom ? new Date(seed.effectiveFrom) : new Date(0);
    if (Number.isNaN(effectiveFrom.getTime())) throw new Error('BILLING_SEED_JSON.effectiveFrom must be an ISO date');
    const result = await pricing.publish({ tenantId, operatorId, reason, effectiveFrom, rates: seed.usagePrices, idempotencyKey: `bootstrap:usage-pricing:${digest}` });
    console.log(JSON.stringify({ kind: 'usage-pricing', revisionId: result.pricingRevisionId, revision: result.revision }));
  }
} finally {
  await connection.end();
}
