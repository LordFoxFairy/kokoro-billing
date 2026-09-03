import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresAdminGrantService, createPostgresCreditAccountQueryService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('user credit account query', () => {
  it('returns only the account owned by the verified site and subject context', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const subjectId = randomUUID();
    const accountId = randomUUID();
    try {
      await createPostgresAdminGrantService(connection).grant({ tenantId, subjectId, accountId, amountMicros: 10, programKey: 'daily', operatorId: 'operator-1', reason: 'test', idempotencyKey: `query-${randomUUID()}` });
      const query = createPostgresCreditAccountQueryService(connection);
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
      const admin = createPostgresAdminGrantService(connection);
      for (const programKey of ['one', 'two', 'three']) {
        await admin.grant({ tenantId, subjectId, accountId, amountMicros: 10, programKey, operatorId: 'operator-1', reason: 'test', idempotencyKey: `ledger-${programKey}-${randomUUID()}` });
      }
      const query = createPostgresCreditAccountQueryService(connection);
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

  it('does not emit a continuation cursor when the result count exactly equals the requested limit', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const subjectId = randomUUID();
    const accountId = randomUUID();
    try {
      const admin = createPostgresAdminGrantService(connection);
      for (const programKey of ['exact-one', 'exact-two']) {
        await admin.grant({ tenantId, subjectId, accountId, amountMicros: 10, programKey, operatorId: 'operator-1', reason: 'test', idempotencyKey: `ledger-${programKey}-${randomUUID()}` });
      }
      const page = await createPostgresCreditAccountQueryService(connection).ledgerForSubject(tenantId, subjectId, 2);
      expect(page.entries).toHaveLength(2);
      expect(page.nextCursor).toBeUndefined();
    } finally {
      await connection.end();
    }
  });

  it('binds ledger cursors to tenant and subject scope', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const firstSubjectId = randomUUID();
    const secondSubjectId = randomUUID();
    const firstAccountId = randomUUID();
    try {
      const admin = createPostgresAdminGrantService(connection);
      for (const programKey of ['scope-one', 'scope-two']) {
        await admin.grant({ tenantId, subjectId: firstSubjectId, accountId: firstAccountId, amountMicros: 10, programKey, operatorId: 'operator-1', reason: 'test', idempotencyKey: `ledger-${programKey}-${randomUUID()}` });
      }
      const first = await createPostgresCreditAccountQueryService(connection).ledgerForSubject(tenantId, firstSubjectId, 1);
      expect(first.nextCursor).toEqual(expect.any(String));
      await expect(createPostgresCreditAccountQueryService(connection).ledgerForSubject(tenantId, secondSubjectId, 1, first.nextCursor)).rejects.toThrow('billing.invalid_cursor');
    } finally {
      await connection.end();
    }
  });

  it('excludes a journal row whose tenant differs from the referenced account tenant', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const subjectId = randomUUID();
    const accountId = randomUUID();
    const contaminatedJournalId = randomUUID();
    try {
      await createPostgresAdminGrantService(connection).grant({ tenantId, subjectId, accountId, amountMicros: 10, programKey: 'owned', operatorId: 'operator-1', reason: 'test', idempotencyKey: `tenant-join-${randomUUID()}` });
      await connection.execute(
        `INSERT INTO entitlement_credit_journal
          (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref)
         VALUES ($1, $2, $3, 999, 'adjustment', 777, 'cross_tenant_probe', $4)`,
        [contaminatedJournalId, otherTenantId, accountId, randomUUID()],
      );

      const page = await createPostgresCreditAccountQueryService(connection).ledgerForSubject(tenantId, subjectId, 10);
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]).toMatchObject({ deltaMicros: '10', balanceAfterMicros: '10' });
    } finally {
      await connection.execute('DELETE FROM entitlement_credit_journal WHERE journal_id = $1', [contaminatedJournalId]);
      await connection.end();
    }
  });
});
