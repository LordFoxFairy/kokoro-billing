import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresAdminGrantService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('admin credit grant', () => {
  it('requires a reason and creates one auditable grant/journal on replay', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = createPostgresAdminGrantService(connection);
    const input = { tenantId: randomUUID(), subjectId: randomUUID(), accountId: randomUUID(), amountMicros: 25, programKey: 'support', operatorId: 'operator-1', reason: 'support adjustment', idempotencyKey: `admin-grant-${randomUUID()}` } as const;
    try {
      const first = await service.grant(input);
      const replay = await service.grant(input);
      expect(replay).toEqual(first);
      const [grants] = await connection.query('SELECT credit_grant_id FROM entitlement_credit_grant WHERE credit_grant_id = $1', [first.grantId]);
      const [audit] = await connection.query('SELECT audit_event_id FROM entitlement_audit_event WHERE resource_id = $1', [first.grantId]);
      expect(grants).toHaveLength(1);
      expect(audit).toHaveLength(1);
      await expect(service.grant({ ...input, amountMicros: 26 })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });

  it('rejects an account id that belongs to a different subject', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = createPostgresAdminGrantService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    try {
      await connection.execute(
        `INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id) VALUES ($1, $2, $3)`,
        [accountId, tenantId, 'subject-owner'],
      );
      await expect(service.grant({ tenantId, subjectId: 'subject-forged', accountId, amountMicros: 25, programKey: 'support', operatorId: 'operator-1', reason: 'support adjustment', idempotencyKey: `admin-grant-mismatch-${randomUUID()}` })).rejects.toThrow('billing.credit_account_mismatch');
    } finally {
      await connection.execute('DELETE FROM entitlement_credit_account WHERE credit_account_id = $1', [accountId]);
      await connection.end();
    }
  });
});
