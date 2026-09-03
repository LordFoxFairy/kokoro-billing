import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { hashRedeemCode } from '../../src/application/credit/services/redeem-code.js';
import { createPostgresRedeemAdminService, createPostgresRedeemService } from '../../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const secret = 'integration-redeem-secret-012345678901234567890123';

integration('redeem card keys', () => {
  it('issues plaintext once, stores only HMAC, and atomically grants once', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const admin = createPostgresRedeemAdminService(connection, secret);
    const redeem = createPostgresRedeemService(connection, secret);
    const tenantId = randomUUID();
    try {
      const campaign = await admin.createCampaign({ tenantId, campaignKey: `test-${randomUUID()}`, programKey: 'ai-pro', creditMicros: 1000, maxRedemptions: 10, operatorId: 'test-operator', reason: 'integration test', idempotencyKey: `campaign-${randomUUID()}` });
      const batchKey = `batch-${randomUUID()}`;
      const batch = await admin.issueCodes({ tenantId, campaignId: campaign.campaignId, count: 1, operatorId: 'test-operator', reason: 'integration test', idempotencyKey: batchKey });
      expect(batch.codes).toHaveLength(1);
      const replayBatch = await admin.issueCodes({ tenantId, campaignId: campaign.campaignId, count: 1, operatorId: 'test-operator', reason: 'integration test', idempotencyKey: batchKey });
      expect(replayBatch.codes).toEqual([]);
      const [stored] = await connection.query<(RowDataPacket & { code_hash: string })[]>('SELECT code_hash FROM entitlement_redeem_code WHERE batch_id = $1', [batch.batchId]);
      const plaintext = batch.codes[0]!;
      expect(stored[0]!.code_hash).toBe(hashRedeemCode(plaintext, secret));
      const input = { tenantId, subjectId: randomUUID(), code: plaintext, idempotencyKey: `redeem-${randomUUID()}` } as const;
      const first = await redeem.redeem(input);
      expect(await redeem.redeem(input)).toEqual(first);
      await expect(redeem.redeem({ ...input, idempotencyKey: `other-${randomUUID()}` })).rejects.toThrow('billing.redeem_invalid');
    } finally { await connection.end(); }
  });
});
