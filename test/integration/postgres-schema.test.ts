import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('billing PostgreSQL schema', () => {
  it('pins connections to the URL schema instead of the role default search_path', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    try {
      const [rows] = await connection.query<(RowDataPacket & { schema_name: string })[]>('SELECT current_schema() AS schema_name');
      expect(rows[0]?.schema_name).toBe(new URL(databaseUrl!).searchParams.get('schema') ?? 'public');
    } finally {
      await connection.end();
    }
  });

  it('enforces owner-prefixed SQL names without duplicated context prefixes', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    try {
      const [tables] = await connection.query<(RowDataPacket & { table_name: string })[]>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      );
      const names = tables.map((row) => row.table_name);
      expect(names).toContain('billing_schema_migrations');
      expect(names.filter((name) => !['billing_schema_migrations', '_prisma_migrations'].includes(name)).every((name) =>
        name.startsWith('entitlement_') || name.startsWith('payment_'),
      )).toBe(true);
      expect(names.some((name) => name.includes('entitlement_entitlement'))).toBe(false);
    } finally {
      await connection.end();
    }
  });

  it('contains both bounded-context owners and a migration receipt', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    try {
      const [tables] = await connection.query<(RowDataPacket & { table_name: string })[]>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name IN ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ORDER BY table_name`,
        ['entitlement_credit_account', 'entitlement_credit_grant', 'entitlement_credit_journal', 'entitlement_offer', 'entitlement_offer_revision', 'entitlement_subscription_term', 'entitlement_redeem_campaign', 'entitlement_redeem_code', 'entitlement_redeem_code_batch', 'payment_command_receipt', 'payment_provider_event', 'payment_settlement'],
      );
      expect(tables.map((row) => row.table_name)).toEqual([
        'entitlement_credit_account',
        'entitlement_credit_grant',
        'entitlement_credit_journal',
        'entitlement_offer',
        'entitlement_offer_revision',
        'entitlement_redeem_campaign',
        'entitlement_redeem_code',
        'entitlement_redeem_code_batch',
        'entitlement_subscription_term',
        'payment_command_receipt',
        'payment_provider_event',
        'payment_settlement',
      ]);

      const [migrations] = await connection.query<(RowDataPacket & { version: string })[]>(
        'SELECT version FROM billing_schema_migrations ORDER BY version',
      );
      expect(migrations).toEqual([
        { version: '0001-billing-core' },
        { version: '0002-payment-fulfillment' },
        { version: '0003-reversal' },
        { version: '0004-checkout' },
        { version: '0005-outbox-leases' },
        { version: '0006-admin-audit' },
        { version: '0007-entitlement-catalog' },
        { version: '0008-usage-pricing' },
        { version: '0009-credit-account-quota' },
        { version: '0010-payment-subscriptions' },
        { version: '0011-provider-event-payload-hash' },
        { version: '0012-payment-outbox-source-unique' },
        { version: '0013-credit-available-semantics' },
        { version: '0014-provider-event-processing-state' },
        { version: '0015-entitlement-subscription-term' },
        { version: '0016-payment-checkout-provider-session' },
        { version: '0017-payment-command-receipt' },
        { version: '0018-outbox-dead-letter' },
        { version: '0019-provider-scoped-payment-refs' },
        { version: '0020-payment-settlement-provider-index' },
        { version: '0021-provider-scoped-subscription-refs' },
        { version: '0022-provider-account-global-identity' },
        { version: '0023-provider-account-checkout-facts' },
        { version: '0024-tenant-id-width' },
        { version: '0025-subscription-period-tenant-lineage' },
        { version: '0026-hold-allocation-tenant-lineage' },
        { version: '0027-tenant-composite-foreign-keys' },
        { version: '0028-tenant-composite-reference-completion' },
        { version: '0029-checkout-offer-revision-lineage' },
        { version: '0030-redeem-codes' },
        { version: '0031-redeem-tenant-fks' },
        { version: '0032-billing-admissions' },
        { version: '0033-provider-account-global-identity' },
        { version: '0034-provider-scoped-settlement-reference' },
        { version: '0035-credit-hold-tenant-lineage' },
        { version: '0036-payment-settlement-checkout-provider-index' },
        { version: '0037-tenant-lineage-composite-foreign-keys' },
        { version: '0038-complete-tenant-lineage' },
      ]);
      const [targetTables] = await connection.query<(RowDataPacket & { table_name: string })[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name IN ($1, $2, $3)
          ORDER BY table_name`,
        ['entitlement_billing_admission', 'entitlement_billing_command_receipt', 'entitlement_execution_event'],
      );
      expect(targetTables.map((row) => row.table_name)).toEqual([
        'entitlement_billing_admission', 'entitlement_billing_command_receipt', 'entitlement_execution_event',
      ]);
      const [targetSiteColumns] = await connection.query<RowDataPacket[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name IN ($1, $2, $3) AND column_name = 'tenant_id'`,
        ['entitlement_billing_admission', 'entitlement_billing_command_receipt', 'entitlement_execution_event'],
      );
      expect(targetSiteColumns).toHaveLength(3);
      const [indexes] = await connection.query<(RowDataPacket & { index_name: string })[]>(
        `SELECT DISTINCT indexname AS "index_name" FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'payment_outbox' AND indexname = 'uq_payment_outbox_source_event'`,
      );
      expect(indexes.map((row) => row.index_name)).toEqual(['uq_payment_outbox_source_event']);
      const [eventColumns] = await connection.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'payment_provider_event' AND column_name = 'payload_hash'`,
      );
      expect(eventColumns.map((row) => row.column_name)).toEqual(['payload_hash']);
      const [checkoutColumns] = await connection.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'payment_checkout' AND column_name IN ('provider', 'provider_session_id', 'checkout_url')
          ORDER BY column_name`,
      );
      expect(checkoutColumns.map((row) => row.column_name)).toEqual(['checkout_url', 'provider', 'provider_session_id']);
      const [settlementColumns] = await connection.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name IN ('payment_settlement', 'payment_reversal') AND column_name = 'provider'
          ORDER BY table_name`,
      );
      expect(settlementColumns.map((row) => row.column_name)).toEqual(['provider', 'provider']);
      const [settlementIndexes] = await connection.query<(RowDataPacket & { index_name: string })[]>(
        `SELECT DISTINCT indexname AS "index_name" FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'payment_settlement' AND indexname = 'ix_payment_settlement_checkout_provider'`,
      );
      expect(settlementIndexes.map((row) => row.index_name)).toEqual(['ix_payment_settlement_checkout_provider']);
      const [subscriptionColumns] = await connection.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'payment_provider_subscription' AND column_name = 'provider'`,
      );
      expect(subscriptionColumns.map((row) => row.column_name)).toEqual(['provider']);
      const [subscriptionIndexes] = await connection.query<(RowDataPacket & { index_name: string })[]>(
        `SELECT DISTINCT indexname AS "index_name" FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'payment_provider_subscription' AND indexname = 'uq_payment_provider_subscription_external'`,
      );
      expect(subscriptionIndexes.map((row) => row.index_name)).toEqual(['uq_payment_provider_subscription_external']);
      const [tenantColumns] = await connection.query<(RowDataPacket & { data_type: string; character_maximum_length: string; collation_name: string })[]>(
        `SELECT data_type AS "data_type", character_maximum_length AS "character_maximum_length", collation_name AS "collation_name"
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'payment_checkout' AND column_name = 'tenant_id'`,
      );
      expect(tenantColumns[0]).toMatchObject({ data_type: 'character varying', character_maximum_length: 191, collation_name: null });
      const [periodColumns] = await connection.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT column_name AS "column_name" FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'payment_subscription_period' AND column_name = 'tenant_id'`,
      );
      expect(periodColumns.map((row) => row.column_name)).toEqual(['tenant_id']);
      const [allocationColumns] = await connection.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT column_name AS "column_name" FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'entitlement_credit_hold_allocation' AND column_name = 'tenant_id'`,
      );
      expect(allocationColumns.map((row) => row.column_name)).toEqual(['tenant_id']);
      const [tenantForeignKeys] = await connection.query<(RowDataPacket & { constraint_name: string })[]>(
        `SELECT DISTINCT constraint_name AS "constraint_name"
           FROM information_schema.table_constraints
          WHERE table_schema = current_schema() AND constraint_type = 'FOREIGN KEY'
            AND constraint_name IN ('fk_entitlement_credit_grant_site_account', 'fk_entitlement_usage_settlement_site_hold', 'fk_payment_reversal_site_settlement', 'fk_payment_customer_binding_site_provider', 'fk_entitlement_subscription_term_site_period', 'fk_payment_checkout_site_offer_revision')
          ORDER BY constraint_name`,
      );
      expect(tenantForeignKeys.map((row) => row.constraint_name)).toEqual([
        'fk_entitlement_credit_grant_site_account',
        'fk_entitlement_subscription_term_site_period',
        'fk_entitlement_usage_settlement_site_hold',
        'fk_payment_checkout_site_offer_revision',
        'fk_payment_customer_binding_site_provider',
        'fk_payment_reversal_site_settlement',
      ]);
      const [billingForeignKeys] = await connection.query<(RowDataPacket & { constraint_name: string; child_columns: string })[]>(
        `SELECT tc.constraint_name AS "constraint_name", string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS "child_columns"
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_schema = tc.constraint_schema
            AND kcu.constraint_name = tc.constraint_name
            AND kcu.table_name = tc.table_name
          WHERE tc.constraint_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'
            AND (tc.table_name LIKE 'entitlement\\_%' OR tc.table_name LIKE 'payment\\_%')
          GROUP BY tc.constraint_name
          ORDER BY tc.constraint_name`,
      );
      expect(billingForeignKeys.some((row) => row.child_columns.split(',').includes('tenant_id'))).toBe(true);
    } finally {
      await connection.end();
    }
  });
});
