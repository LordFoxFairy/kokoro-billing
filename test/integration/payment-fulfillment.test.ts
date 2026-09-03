import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresBillingSettlementService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('payment settlement to credit fulfillment', () => {
  it('fulfills a settlement exactly once and writes one grant and journal', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const settlementId = randomUUID();
      const sourceRef = `test-payment-${randomUUID()}`;
    try {
      await service.recordSettlement({ settlementId, tenantId, externalPaymentRef: sourceRef, amountMinor: 1000, currency: 'USD' });
      await service.recordSettlement({ settlementId, tenantId, externalPaymentRef: sourceRef, amountMinor: 1000, currency: 'USD' });
      const first = await service.fulfillSettlement({ settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'test-plan', grantMicros: 100 });
      const second = await service.fulfillSettlement({ settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'test-plan', grantMicros: 100 });

      expect(first.fulfillmentId).toBe(second.fulfillmentId);
      const [grants] = await connection.query('SELECT credit_grant_id FROM entitlement_credit_grant WHERE source_ref = $1', [settlementId]);
      const [journal] = await connection.query('SELECT journal_id FROM entitlement_credit_journal WHERE source_ref = $1', [settlementId]);
      const [outbox] = await connection.query('SELECT outbox_id FROM payment_outbox WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_type = $3', ['payment_settlement', settlementId, 'PaymentSettlementRecorded']);
      expect(grants).toHaveLength(1);
      expect(journal).toHaveLength(1);
      expect(outbox).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it('serializes concurrent fulfillment attempts on the settlement source fact', async () => {
    const firstConnection = await createBillingConnection(databaseUrl!);
    const secondConnection = await createBillingConnection(databaseUrl!);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const settlementId = randomUUID();
    const sourceRef = `test-concurrent-payment-${randomUUID()}`;
    const input = { settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'test-plan', grantMicros: 100 } as const;
    try {
      await createPostgresBillingSettlementService(firstConnection).recordSettlement({ settlementId, tenantId, externalPaymentRef: sourceRef, amountMinor: 1000, currency: 'USD' });
      const [first, second] = await Promise.all([
        createPostgresBillingSettlementService(firstConnection).fulfillSettlement(input),
        createPostgresBillingSettlementService(secondConnection).fulfillSettlement(input),
      ]);
      expect(first.fulfillmentId).toBe(second.fulfillmentId);
      const [grants] = await firstConnection.query('SELECT credit_grant_id FROM entitlement_credit_grant WHERE source_ref = $1', [settlementId]);
      const [journal] = await firstConnection.query('SELECT journal_id FROM entitlement_credit_journal WHERE source_ref = $1', [settlementId]);
      expect(grants).toHaveLength(1);
      expect(journal).toHaveLength(1);
    } finally {
      await firstConnection.end();
      await secondConnection.end();
    }
  });

  it('rejects reuse of an external payment reference with a different settlement id', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const sourceRef = `test-conflict-payment-${randomUUID()}`;
    try {
      await service.recordSettlement({ settlementId: randomUUID(), tenantId, externalPaymentRef: sourceRef, amountMinor: 1000, currency: 'USD' });
      await expect(service.recordSettlement({ settlementId: randomUUID(), tenantId, externalPaymentRef: sourceRef, amountMinor: 1000, currency: 'USD' })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });

  it('scopes external payment references by provider', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const externalPaymentRef = `shared-provider-ref-${randomUUID()}`;
    try {
      await service.recordSettlement({ settlementId: randomUUID(), tenantId, provider: 'stripe', externalPaymentRef, amountMinor: 1000, currency: 'USD' });
      await expect(service.recordSettlement({ settlementId: randomUUID(), tenantId, provider: 'wechat', externalPaymentRef, amountMinor: 1000, currency: 'USD' })).resolves.toBeUndefined();
    } finally {
      await connection.end();
    }
  });

  it('rejects fulfillment replay with a different grant payload', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const settlementId = randomUUID();
    try {
      await service.recordSettlement({ settlementId, tenantId, externalPaymentRef: `test-fulfillment-conflict-${randomUUID()}`, amountMinor: 1000, currency: 'USD' });
      await service.fulfillSettlement({ settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'plan-a', grantMicros: 100 });
      await expect(service.fulfillSettlement({ settlementId, tenantId, accountId, subjectId: `subject-${accountId}`, programKey: 'plan-b', grantMicros: 100 })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });
});
