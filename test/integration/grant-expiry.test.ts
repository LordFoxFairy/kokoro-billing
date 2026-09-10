import { assertDefined } from '../assert-defined.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresGrantExpiryService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('credit grant expiry', () => {
  it('expires unused grant balance transactionally and is replay-safe', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const service = createPostgresGrantExpiryService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const grantId = randomUUID();
    try {
      await connection.execute(`INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id, available_micros) VALUES ($1, $2, $3, 100)`, [accountId, tenantId, `subject-${accountId}`]);
      await connection.execute(
        `INSERT INTO entitlement_credit_grant
          (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key, original_micros, remaining_micros, effective_at, expires_at, status)
         VALUES ($1, $2, $3, 'subscription_period', $4, 'pro', 100, 100, CURRENT_TIMESTAMP(3) - INTERVAL '2 days', CURRENT_TIMESTAMP(3) - INTERVAL '1 day', 'active')`,
        [grantId, tenantId, accountId, `period-${grantId}`],
      );
      await expect(service.expireExpiredGrants({ tenantId })).resolves.toEqual({ expiredGrantIds: [grantId] });
      await expect(service.expireExpiredGrants({ tenantId })).resolves.toEqual({ expiredGrantIds: [] });
      const [grantRows] = await connection.query<(RowDataPacket & { remaining_micros: string; status: string })[]>('SELECT remaining_micros, status FROM entitlement_credit_grant WHERE credit_grant_id = $1', [grantId]);
      const [accountRows] = await connection.query<(RowDataPacket & { available_micros: string })[]>('SELECT available_micros FROM entitlement_credit_account WHERE credit_account_id = $1', [accountId]);
      const [journalRows] = await connection.query('SELECT journal_id FROM entitlement_credit_journal WHERE tenant_id = $1 AND source_kind = \'grant_expiry\' AND source_ref = $2', [tenantId, grantId]);
      expect(grantRows[0]).toMatchObject({ remaining_micros: '0', status: 'expired' });
      expect(accountRows[0]?.available_micros).toBe('0');
      expect(journalRows).toHaveLength(1);
    } finally {
      await connection.execute('DELETE FROM entitlement_outbox WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_credit_journal WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_credit_grant WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_credit_account WHERE tenant_id = $1', [tenantId]);
      await connection.end();
    }
  });

  it('defers expiry while an active hold still owns grant allocation', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const service = createPostgresGrantExpiryService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const grantId = randomUUID();
    const holdId = randomUUID();
    try {
      await connection.execute(`INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id, available_micros, held_micros) VALUES ($1, $2, $3, 100, 30)`, [accountId, tenantId, `subject-${accountId}`]);
      await connection.execute(
        `INSERT INTO entitlement_credit_grant
          (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key, original_micros, remaining_micros, effective_at, expires_at, status)
         VALUES ($1, $2, $3, 'subscription_period', $4, 'pro', 100, 100, CURRENT_TIMESTAMP(3) - INTERVAL '2 days', CURRENT_TIMESTAMP(3) - INTERVAL '1 day', 'active')`,
        [grantId, tenantId, accountId, `period-${grantId}`],
      );
      await connection.execute(
        `INSERT INTO entitlement_credit_hold
          (credit_hold_id, tenant_id, credit_account_id, idempotency_key, requested_micros, status, expires_at)
         VALUES ($1, $2, $3, $4, 30, 'active', CURRENT_TIMESTAMP(3) + INTERVAL '1 hour')`,
        [holdId, tenantId, accountId, `hold-${holdId}`],
      );
      await connection.execute(
        `INSERT INTO entitlement_credit_hold_allocation (credit_hold_id, tenant_id, credit_grant_id, held_micros)
         VALUES ($1, $2, $3, 30)`,
        [holdId, tenantId, grantId],
      );

      await expect(service.expireExpiredGrants({ tenantId })).resolves.toEqual({ expiredGrantIds: [] });
      const [activeRows] = await connection.query<RowDataPacket[]>('SELECT status, remaining_micros FROM entitlement_credit_grant WHERE credit_grant_id = $1', [grantId]);
      expect(activeRows[0]).toMatchObject({ status: 'active', remaining_micros: '100' });

      await connection.execute(`UPDATE entitlement_credit_hold SET status = 'released', released_micros = requested_micros WHERE credit_hold_id = $1`, [holdId]);
      await expect(service.expireExpiredGrants({ tenantId })).resolves.toEqual({ expiredGrantIds: [grantId] });
    } finally {
      await connection.execute('DELETE FROM entitlement_credit_hold_allocation WHERE credit_grant_id = $1', [grantId]);
      await connection.execute('DELETE FROM entitlement_credit_hold WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_outbox WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_credit_journal WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_credit_grant WHERE tenant_id = $1', [tenantId]);
      await connection.execute('DELETE FROM entitlement_credit_account WHERE tenant_id = $1', [tenantId]);
      await connection.end();
    }
  });

  it('uses tenant-scoped application predicates instead of database relationship constraints', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const siteA = randomUUID();
    const siteB = randomUUID();
    const accountId = randomUUID();
    const grantId = randomUUID();
    const holdId = randomUUID();
    try {
      await connection.execute(`INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id, available_micros) VALUES ($1, $2, $3, 10)`, [accountId, siteA, `subject-${accountId}`]);
      await connection.execute(
        `INSERT INTO entitlement_credit_grant
          (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key, original_micros, remaining_micros, effective_at, status)
         VALUES ($1, $2, $3, 'admin_grant', $4, 'test', 10, 10, CURRENT_TIMESTAMP(3), 'active')`,
        [grantId, siteA, accountId, `grant-${grantId}`],
      );
      await connection.execute(
        `INSERT INTO entitlement_credit_hold
          (credit_hold_id, tenant_id, credit_account_id, idempotency_key, requested_micros, expires_at)
         VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP(3) + INTERVAL '1 hour')`,
        [holdId, siteA, accountId, `hold-${holdId}`],
      );
      const [constraints] = await connection.query<RowDataPacket[]>(
        `SELECT constraint_name
           FROM information_schema.table_constraints
          WHERE table_schema = current_schema() AND table_name = 'entitlement_credit_hold_allocation'
            AND constraint_type = 'FOREIGN KEY'`,
      );
      expect(constraints).toEqual([]);
      await connection.execute(
        `INSERT INTO entitlement_credit_hold_allocation (credit_hold_id, tenant_id, credit_grant_id, held_micros) VALUES ($1, $2, $3, 1)`,
        [holdId, siteB, grantId],
      );
      const [tenantScopedRows] = await connection.query<RowDataPacket[]>(
        `SELECT credit_hold_id
           FROM entitlement_credit_hold_allocation
          WHERE tenant_id = $1 AND credit_hold_id = $2 AND credit_grant_id = $3`,
        [siteA, holdId, grantId],
      );
      expect(tenantScopedRows).toEqual([]);
    } finally {
      await connection.execute('DELETE FROM entitlement_credit_hold_allocation WHERE credit_hold_id = $1', [holdId]);
      await connection.execute('DELETE FROM entitlement_credit_hold WHERE credit_hold_id = $1', [holdId]);
      await connection.execute('DELETE FROM entitlement_credit_grant WHERE credit_grant_id = $1', [grantId]);
      await connection.execute('DELETE FROM entitlement_credit_account WHERE credit_account_id = $1', [accountId]);
      await connection.end();
    }
  });
});
