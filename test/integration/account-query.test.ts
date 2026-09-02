import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { CreditAccountQueryService } from '../../src/modules/credit/account-query-service.js';
import { AdminGrantService } from '../../src/modules/credit/admin-grant-service.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('user credit account query', () => {
  it('returns only the account owned by the verified site and subject context', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const subjectId = randomUUID();
    const accountId = randomUUID();
    try {
      await new AdminGrantService(connection).grant({ tenantId, subjectId, accountId, amountMicros: 10, programKey: 'daily', operatorId: 'operator-1', reason: 'test', idempotencyKey: `query-${randomUUID()}` });
      const query = new CreditAccountQueryService(connection);
      expect(await query.getForSubject(tenantId, subjectId)).toMatchObject({ accountId, availableMicros: '10', heldMicros: '0' });
      expect(await query.getForSubject(tenantId, randomUUID())).toBeNull();
    } finally {
      await connection.end();
    }
  });

  it('paginates the ledger with an opaque cursor without resetting balance snapshots', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const subjectId = randomUUID();
    const accountId = randomUUID();
    try {
      const admin = new AdminGrantService(connection);
      for (const programKey of ['one', 'two', 'three']) {
        await admin.grant({ tenantId, subjectId, accountId, amountMicros: 10, programKey, operatorId: 'operator-1', reason: 'test', idempotencyKey: `ledger-${programKey}-${randomUUID()}` });
      }
      const query = new CreditAccountQueryService(connection);
      const first = await query.ledgerForSubject(tenantId, subjectId, 2);
      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await query.ledgerForSubject(tenantId, subjectId, 2, first.nextCursor);
      expect(second.entries).toHaveLength(1);
      expect(second.nextCursor).toBeUndefined();
      expect(second.entries[0]).toMatchObject({ balanceAfterMicros: '10' });
    } finally {
      await connection.end();
    }
  });
});
