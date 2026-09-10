import { assertDefined } from '../assert-defined.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresAdminStatsService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('admin billing stats', () => {
  it('returns site-scoped zero-safe aggregates', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    try {
      const stats = await createPostgresAdminStatsService(connection).get(randomUUID());
      expect(stats.checkouts).toEqual({});
      expect(stats.settlements.byStatus).toEqual({});
      expect(stats.reversals.byStatus).toEqual({});
      expect(stats.providerEvents).toEqual({});
      expect(stats.credit).toEqual({ accountCount: '0', grantCount: '0', remainingMicros: '0' });
      const adminStats = createPostgresAdminStatsService(connection);
      expect(await adminStats.listCreditOperations(randomUUID())).toEqual([]);
      expect(await adminStats.listPaymentOperations(randomUUID())).toEqual([]);
    } finally {
      await connection.end();
    }
  });
});
