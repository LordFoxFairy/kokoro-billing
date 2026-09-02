import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import { BillingSettlementService } from '../../src/modules/payment/billing-settlement-service.js';
import { UsageSettlementService } from '../../src/modules/metering/usage-settlement-service.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('usage authorization and settlement', () => {
  it('holds by grant burn order, captures actual usage and releases the difference', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const settlement = new BillingSettlementService(connection);
    const usage = new UsageSettlementService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const settlementId = randomUUID();
    const usageEventId = randomUUID();
    try {
      await settlement.recordSettlement({ settlementId, tenantId, externalPaymentRef: `usage-payment-${randomUUID()}`, amountMinor: 1000, currency: 'USD' });
      await settlement.fulfillSettlement({ settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'usage-plan', grantMicros: 100 });
      await usage.recordUsageEvent({ usageEventId, tenantId, subjectId: `subject-${accountId}`, sourceEventId: `usage-${randomUUID()}`, featureKey: 'model.request', quantityMicros: 30 });
      const foreignUsageEventId = randomUUID();
      await usage.recordUsageEvent({ usageEventId: foreignUsageEventId, tenantId, subjectId: `other-subject-${accountId}`, sourceEventId: `usage-${randomUUID()}`, featureKey: 'model.request', quantityMicros: 30 });
      const holdKey = `hold-${randomUUID()}`;
      const hold = await usage.authorizeUsage({ tenantId, accountId, idempotencyKey: holdKey, requestedMicros: 30, featureKey: 'model.request' });
      await expect(usage.authorizeUsage({ tenantId, accountId, idempotencyKey: holdKey, requestedMicros: 31, featureKey: 'model.request' })).rejects.toThrow('billing.idempotency_conflict');
      const [heldRows] = await connection.query<RowDataPacket[]>('SELECT available_micros, held_micros FROM entitlement_credit_account WHERE credit_account_id = $1', [accountId]);
      expect(String(heldRows[0]?.available_micros)).toBe('70');
      expect(String(heldRows[0]?.held_micros)).toBe('30');
      await expect(usage.settleUsage({ tenantId, holdId: hold.holdId, usageEventId: foreignUsageEventId, idempotencyKey: `settle-foreign-${randomUUID()}`, actualMicros: 20 })).rejects.toThrow('billing.usage_event_mismatch');
      const first = await usage.settleUsage({ tenantId, holdId: hold.holdId, usageEventId, idempotencyKey: `settle-${randomUUID()}`, actualMicros: 20 });
      const second = await usage.settleUsage({ tenantId, holdId: hold.holdId, usageEventId, idempotencyKey: `settle-replay-${randomUUID()}`, actualMicros: 20 });
      expect(first).toEqual(second);
      await expect(usage.settleUsage({ tenantId, holdId: hold.holdId, usageEventId, idempotencyKey: `settle-conflict-${randomUUID()}`, actualMicros: 19 })).rejects.toThrow('billing.idempotency_conflict');
      const [accountRows] = await connection.query<(RowDataPacket & { available_micros: string; held_micros: string })[]>('SELECT available_micros, held_micros FROM entitlement_credit_account WHERE credit_account_id = $1', [accountId]);
      expect(accountRows[0]?.available_micros).toBe('80');
      expect(accountRows[0]?.held_micros).toBe('0');
    } finally {
      await connection.end();
    }
  });

  it('releases an active hold idempotently without debiting the account', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const settlement = new BillingSettlementService(connection);
    const usage = new UsageSettlementService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    try {
      const settlementId = randomUUID();
      await settlement.recordSettlement({ settlementId, tenantId, externalPaymentRef: `release-payment-${randomUUID()}`, amountMinor: 1000, currency: 'USD' });
      await settlement.fulfillSettlement({ settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'release-plan', grantMicros: 100 });
      const hold = await usage.authorizeUsage({ tenantId, accountId, idempotencyKey: `release-hold-${randomUUID()}`, requestedMicros: 30, featureKey: 'model.request' });
      const first = await usage.releaseUsage({ tenantId, holdId: hold.holdId, idempotencyKey: `release-${randomUUID()}` });
      const replay = await usage.releaseUsage({ tenantId, holdId: hold.holdId, idempotencyKey: `release-replay-${randomUUID()}` });
      expect(first).toEqual(replay);
      const [accountRows] = await connection.query<(RowDataPacket & { available_micros: number; held_micros: number })[]>('SELECT available_micros, held_micros FROM entitlement_credit_account WHERE credit_account_id = $1', [accountId]);
      expect(Number(accountRows[0]?.available_micros)).toBe(100);
      expect(Number(accountRows[0]?.held_micros)).toBe(0);
    } finally {
      await connection.end();
    }
  });

  it('expires abandoned holds and returns their reservation to the account', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const settlement = new BillingSettlementService(connection);
    const usage = new UsageSettlementService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    try {
      const settlementId = randomUUID();
      await settlement.recordSettlement({ settlementId, tenantId, externalPaymentRef: `expiry-payment-${randomUUID()}`, amountMinor: 1000, currency: 'USD' });
      await settlement.fulfillSettlement({ settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'expiry-plan', grantMicros: 100 });
      const hold = await usage.authorizeUsage({ tenantId, accountId, idempotencyKey: `expiry-hold-${randomUUID()}`, requestedMicros: 30, featureKey: 'model.request' });
      await connection.execute(`UPDATE entitlement_credit_hold SET expires_at = CURRENT_TIMESTAMP(6) - INTERVAL '1 second' WHERE credit_hold_id = $1`, [hold.holdId]);
      expect(await usage.expireExpiredHolds({ tenantId })).toEqual({ expiredHoldIds: [hold.holdId] });
      expect(await usage.expireExpiredHolds({ tenantId })).toEqual({ expiredHoldIds: [] });
      const [accountRows] = await connection.query<RowDataPacket[]>('SELECT available_micros, held_micros FROM entitlement_credit_account WHERE credit_account_id = $1', [accountId]);
      expect(Number(accountRows[0]?.available_micros)).toBe(100);
      expect(Number(accountRows[0]?.held_micros)).toBe(0);
    } finally {
      await connection.end();
    }
  });

  it('rejects a usage event replay with a different payload', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const usage = new UsageSettlementService(connection);
    const tenantId = randomUUID();
    try {
      await usage.recordUsageEvent({ usageEventId: randomUUID(), tenantId, subjectId: 'subject-1', sourceEventId: 'provider-event-1', featureKey: 'model.request', quantityMicros: 10, dimensions: { model: 'MODEL', region: 'us-east' } });
      await expect(usage.recordUsageEvent({ usageEventId: randomUUID(), tenantId, subjectId: 'subject-1', sourceEventId: 'provider-event-1', featureKey: 'model.request', quantityMicros: 10, dimensions: { model: 'OTHER', region: 'us-east' } })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });
});
