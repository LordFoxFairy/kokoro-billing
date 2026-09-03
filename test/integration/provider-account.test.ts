import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresProviderAccountService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('provider account tenant routing', () => {
  it('resolves a provider account to exactly one active site', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const externalAccountRef = `acct-${randomUUID()}`;
    try {
      await connection.execute(
        `INSERT INTO payment_provider_account (provider_account_id, tenant_id, provider, external_account_ref, status)
         VALUES ($1, $2, 'stripe', $3, 'active')`,
        [randomUUID(), tenantId, externalAccountRef],
      );
      const accounts = createPostgresProviderAccountService(connection);
      await expect(accounts.resolveTenantId('stripe', externalAccountRef)).resolves.toBe(tenantId);
      await expect(accounts.resolveTenantId('stripe', 'unknown-account')).resolves.toBeNull();
      await expect(connection.execute(
        `INSERT INTO payment_provider_account (provider_account_id, tenant_id, provider, external_account_ref, status)
         VALUES ($1, $2, 'stripe', $3, 'active')`,
        [randomUUID(), randomUUID(), externalAccountRef],
      )).rejects.toThrow();
    } finally {
      await connection.execute('DELETE FROM payment_provider_account WHERE tenant_id = $1', [tenantId]);
      await connection.end();
    }
  });
});
