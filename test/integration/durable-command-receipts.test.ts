import { assertDefined } from '../assert-defined.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import {
  createPostgresBillingSettlementService,
  createPostgresUsageSettlementService,
} from '../../src/infrastructure/postgres/create-postgres-services.js';

const payloadHashMatcher: unknown = expect.stringMatching(/^[0-9a-f]{64}$/u);

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('durable Billing command receipts', () => {
  it('replays settlement acceptance from PostgreSQL after the Redis hint can expire', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const settlement = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const idempotencyKey = `settlement-${randomUUID()}`;
    const input = {
      tenantId,
      settlementId,
      idempotencyKey,
      provider: 'stripe',
      externalPaymentRef: `payment-${randomUUID()}`,
      amountMinor: 1_000,
      currency: 'USD',
    } as const;

    try {
      const first = await settlement.recordSettlement(input);
      const replay = await settlement.recordSettlement(input);
      const identityReplay = await settlement.recordSettlement({
        ...input,
        idempotencyKey: `settlement-alternate-${randomUUID()}`,
      });

      expect(first).toEqual({ settlementId, accepted: true });
      expect(replay).toEqual(first);
      expect(identityReplay).toEqual(first);
      const [receipts] = await connection.query<(RowDataPacket & {
        command_name: string;
        command_identity: string;
        idempotency_key: string;
        payload_hash: string;
        status: string;
        result_json: Record<string, unknown>;
      })[]>(
        `SELECT command_name, command_identity, idempotency_key, payload_hash, status, result_json
           FROM payment_command_receipt
          WHERE tenant_id = $1 AND command_name = 'payment.settlement.accept' AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        command_name: 'payment.settlement.accept',
        command_identity: settlementId,
        idempotency_key: idempotencyKey,
        payload_hash: payloadHashMatcher,
        status: 'succeeded',
        result_json: { settlementId, accepted: true },
      });
    } finally {
      await connection.end();
    }
  });

  it('rejects settlement key reuse for a different command payload', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const settlement = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const idempotencyKey = `settlement-${randomUUID()}`;
    try {
      await settlement.recordSettlement({
        tenantId,
        settlementId: randomUUID(),
        idempotencyKey,
        provider: 'stripe',
        externalPaymentRef: `payment-${randomUUID()}`,
        amountMinor: 1_000,
        currency: 'USD',
      });
      await expect(settlement.recordSettlement({
        tenantId,
        settlementId: randomUUID(),
        idempotencyKey,
        provider: 'stripe',
        externalPaymentRef: `payment-${randomUUID()}`,
        amountMinor: 2_000,
        currency: 'USD',
      })).rejects.toThrow('billing.idempotency_conflict');
      const [settlements] = await connection.query<RowDataPacket[]>(
        'SELECT settlement_id FROM payment_settlement WHERE tenant_id = $1',
        [tenantId],
      );
      expect(settlements).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it('rejects settlement payload drift under the same key and settlement identity', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const settlement = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const idempotencyKey = `settlement-${randomUUID()}`;
    const input = {
      tenantId,
      settlementId,
      idempotencyKey,
      provider: 'stripe',
      externalPaymentRef: `payment-${randomUUID()}`,
      amountMinor: 1_000,
      currency: 'USD',
    } as const;
    try {
      await settlement.recordSettlement(input);
      await expect(settlement.recordSettlement({ ...input, amountMinor: 2_000 })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });

  it('serializes concurrent settlement retries onto one durable receipt', async () => {
    const firstConnection = await createBillingConnection(assertDefined(databaseUrl));
    const secondConnection = await createBillingConnection(assertDefined(databaseUrl));
    const tenantId = randomUUID();
    const settlementId = randomUUID();
    const input = {
      tenantId,
      settlementId,
      idempotencyKey: `settlement-${randomUUID()}`,
      provider: 'stripe',
      externalPaymentRef: `payment-${randomUUID()}`,
      amountMinor: 1_000,
      currency: 'USD',
    } as const;
    try {
      const [first, second] = await Promise.all([
        createPostgresBillingSettlementService(firstConnection).recordSettlement(input),
        createPostgresBillingSettlementService(secondConnection).recordSettlement(input),
      ]);
      expect(first).toEqual(second);
      const [receipts] = await firstConnection.query<RowDataPacket[]>(
        `SELECT receipt_id FROM payment_command_receipt
          WHERE tenant_id = $1 AND command_name = 'payment.settlement.accept' AND command_identity = $2`,
        [tenantId, settlementId],
      );
      expect(receipts).toHaveLength(1);
    } finally {
      await firstConnection.end();
      await secondConnection.end();
    }
  });

  it('replays an expiry batch result without consuming the next eligible batch', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const settlement = createPostgresBillingSettlementService(connection);
    const usage = createPostgresUsageSettlementService(connection);
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const subjectId = `subject-${accountId}`;
    const batchId = `expiry-batch-${randomUUID()}`;
    const idempotencyKey = `expiry-${randomUUID()}`;

    const createExpiredHold = async (suffix: string): Promise<string> => {
      const settlementId = randomUUID();
      await settlement.recordSettlement({
        tenantId,
        settlementId,
        idempotencyKey: `seed-settlement-${suffix}-${randomUUID()}`,
        provider: 'stripe',
        externalPaymentRef: `seed-payment-${suffix}-${randomUUID()}`,
        amountMinor: 1_000,
        currency: 'USD',
      });
      await settlement.fulfillSettlement({
        settlementId,
        tenantId,
        accountId,
        subjectId,
        programKey: `expiry-plan-${suffix}`,
        grantMicros: 100,
      });
      const hold = await usage.authorizeUsage({
        tenantId,
        accountId,
        idempotencyKey: `hold-${suffix}-${randomUUID()}`,
        requestedMicros: 30,
        featureKey: 'model.request',
      });
      await connection.execute(
        `UPDATE entitlement_credit_hold
            SET expires_at = CURRENT_TIMESTAMP(3) - INTERVAL '1 second'
          WHERE tenant_id = $1 AND credit_hold_id = $2`,
        [tenantId, hold.holdId],
      );
      return hold.holdId;
    };

    try {
      const firstHoldId = await createExpiredHold('first');
      const command = { tenantId, batchId, idempotencyKey, limit: 1 } as const;
      const first = await usage.expireExpiredHolds(command);
      expect(first).toEqual({ batchId, expiredHoldIds: [firstHoldId] });

      const secondHoldId = await createExpiredHold('second');
      const replay = await usage.expireExpiredHolds(command);
      expect(replay).toEqual(first);
      const identityReplay = await usage.expireExpiredHolds({
        ...command,
        idempotencyKey: `expiry-alternate-${randomUUID()}`,
      });
      expect(identityReplay).toEqual(first);
      await expect(usage.expireExpiredHolds({
        ...command,
        batchId: `expiry-next-${randomUUID()}`,
      })).rejects.toThrow('billing.idempotency_conflict');

      const [secondHolds] = await connection.query<(RowDataPacket & { status: string })[]>(
        `SELECT status FROM entitlement_credit_hold
          WHERE tenant_id = $1 AND credit_hold_id = $2`,
        [tenantId, secondHoldId],
      );
      expect(secondHolds[0]?.status).toBe('active');
      const [receipts] = await connection.query<(RowDataPacket & {
        command_identity: string;
        payload_hash: string;
        status: string;
        result_json: Record<string, unknown>;
      })[]>(
        `SELECT command_identity, payload_hash, status, result_json
           FROM entitlement_command_receipt
          WHERE tenant_id = $1 AND command_name = 'entitlement.credit-holds.expire' AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      expect(receipts).toEqual([expect.objectContaining({
        command_identity: batchId,
        payload_hash: payloadHashMatcher,
        status: 'succeeded',
        result_json: { batchId, expiredHoldIds: [firstHoldId] },
      })]);
    } finally {
      await connection.end();
    }
  });

  it('rejects expiry payload drift under the same key and batch identity', async () => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const usage = createPostgresUsageSettlementService(connection);
    const tenantId = randomUUID();
    const batchId = `expiry-batch-${randomUUID()}`;
    const idempotencyKey = `expiry-${randomUUID()}`;
    try {
      await usage.expireExpiredHolds({ tenantId, batchId, idempotencyKey, limit: 1 });
      await expect(usage.expireExpiredHolds({ tenantId, batchId, idempotencyKey, limit: 2 })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });

  it.each([
    { status: 'failed', expected: 'billing.command_failed' },
    { status: 'unknown', expected: 'billing.command_unknown' },
    { status: 'processing', expected: 'billing.command_unknown' },
  ] as const)('returns the stable $status outcome for a durable settlement receipt', async ({ status, expected }) => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const settlement = createPostgresBillingSettlementService(connection);
    const tenantId = randomUUID();
    const input = {
      tenantId,
      settlementId: randomUUID(),
      idempotencyKey: `settlement-state-${randomUUID()}`,
      provider: 'stripe',
      externalPaymentRef: `payment-state-${randomUUID()}`,
      amountMinor: 1_000,
      currency: 'USD',
    } as const;
    try {
      await settlement.recordSettlement(input);
      await connection.execute(
        `UPDATE payment_command_receipt SET status = $1, result_json = NULL
          WHERE tenant_id = $2 AND command_name = 'payment.settlement.accept' AND idempotency_key = $3`,
        [status, tenantId, input.idempotencyKey],
      );
      await expect(settlement.recordSettlement(input)).rejects.toThrow(expected);
    } finally {
      await connection.end();
    }
  });

  it.each([
    { status: 'failed', expected: 'billing.command_failed' },
    { status: 'unknown', expected: 'billing.command_unknown' },
    { status: 'processing', expected: 'billing.command_unknown' },
  ] as const)('returns the stable $status outcome for a durable expiry receipt', async ({ status, expected }) => {
    const connection = await createBillingConnection(assertDefined(databaseUrl));
    const usage = createPostgresUsageSettlementService(connection);
    const tenantId = randomUUID();
    const input = {
      tenantId,
      batchId: `expiry-state-${randomUUID()}`,
      idempotencyKey: `expiry-state-${randomUUID()}`,
      limit: 1,
    } as const;
    try {
      await usage.expireExpiredHolds(input);
      await connection.execute(
        `UPDATE entitlement_command_receipt SET status = $1, result_json = NULL
          WHERE tenant_id = $2 AND command_name = 'entitlement.credit-holds.expire' AND idempotency_key = $3`,
        [status, tenantId, input.idempotencyKey],
      );
      await expect(usage.expireExpiredHolds(input)).rejects.toThrow(expected);
    } finally {
      await connection.end();
    }
  });
});
