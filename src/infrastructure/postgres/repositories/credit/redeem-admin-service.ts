import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, ResultSetHeader, RowDataPacket } from '../../database.js';
import { generateRedeemCode, hashRedeemCode } from '../../../../application/credit/services/redeem-code.js';
import { z, type ZodType } from 'zod';
import { parsePersistedJson } from '../../json.js';

export type CreateCampaignInput = { readonly tenantId: string; readonly campaignKey: string; readonly programKey: string; readonly creditMicros: number; readonly maxRedemptions: number; readonly startsAt?: Date; readonly endsAt?: Date | null; readonly idempotencyKey: string; readonly operatorId: string; readonly reason: string };
export type IssueCodesInput = { readonly tenantId: string; readonly campaignId: string; readonly count: number; readonly idempotencyKey: string; readonly operatorId: string; readonly reason: string };
export type CampaignResult = { readonly campaignId: string; readonly campaignKey: string };
export type IssueCodesResult = { readonly batchId: string; readonly campaignId: string; readonly codes: readonly string[] };
type Receipt = RowDataPacket & { payload_hash: string; result_json: string | null; status: string };
const campaignResultSchema = z.object({ campaignId: z.string().min(1), campaignKey: z.string().min(1) }).strict();
const issueCodesResultSchema = z.object({ batchId: z.string().min(1), campaignId: z.string().min(1), codes: z.array(z.string()) }).strict();
const emptyResultSchema = z.object({}).strict();

export class RedeemAdminService {
  public constructor(private readonly connection: SqlConnection, private readonly secret: string) {}

  public async createCampaign(input: CreateCampaignInput): Promise<CampaignResult> {
    if (!Number.isSafeInteger(input.creditMicros) || input.creditMicros <= 0 || !Number.isSafeInteger(input.maxRedemptions) || input.maxRedemptions <= 0) throw new Error('billing.redeem_invalid_campaign');
    return this.withReceipt('RedeemCreateCampaign', input.tenantId, input.idempotencyKey, { ...input, idempotencyKey: undefined }, campaignResultSchema, async () => {
      const campaignId = randomUUID();
      await this.connection.execute(`INSERT INTO entitlement_redeem_campaign (campaign_id, tenant_id, campaign_key, program_key, credit_micros, max_redemptions, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [campaignId, input.tenantId, input.campaignKey, input.programKey, input.creditMicros, input.maxRedemptions, input.startsAt ?? new Date(), input.endsAt ?? null]);
      await this.audit(input.tenantId, input.operatorId, 'redeem_campaign_created', input.operatorId, campaignId, input.reason, { campaignKey: input.campaignKey, programKey: input.programKey });
      return { campaignId, campaignKey: input.campaignKey } satisfies CampaignResult;
    });
  }

  public async issueCodes(input: IssueCodesInput): Promise<IssueCodesResult> {
    if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 10_000) throw new Error('billing.redeem_invalid_batch');
    return this.withReceipt('RedeemIssueCodes', input.tenantId, input.idempotencyKey, { ...input, idempotencyKey: undefined }, issueCodesResultSchema, async () => {
      const [campaigns] = await this.connection.execute<RowDataPacket[]>(`SELECT campaign_id FROM entitlement_redeem_campaign WHERE tenant_id = $1 AND campaign_id = $2 FOR UPDATE`, [input.tenantId, input.campaignId]);
      if (!campaigns[0]) throw new Error('billing.redeem_campaign_not_found');
      const batchId = randomUUID();
      await this.connection.execute(`INSERT INTO entitlement_redeem_code_batch (batch_id, tenant_id, campaign_id, requested_count, created_by, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [batchId, input.tenantId, input.campaignId, input.count, input.operatorId, input.reason]);
      const codes: string[] = [];
      for (let i = 0; i < input.count; i += 1) { const plaintext = generateRedeemCode(); codes.push(plaintext); await this.connection.execute(`INSERT INTO entitlement_redeem_code (code_id, tenant_id, campaign_id, batch_id, code_hash) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), input.tenantId, input.campaignId, batchId, hashRedeemCode(plaintext, this.secret)]); }
      await this.connection.execute(`UPDATE entitlement_redeem_code_batch SET issued_count = $1 WHERE batch_id = $2`, [codes.length, batchId]);
      await this.audit(input.tenantId, input.operatorId, 'redeem_code_batch_issued', input.operatorId, batchId, input.reason, { campaignId: input.campaignId, count: input.count });
      return { batchId, campaignId: input.campaignId, codes };
    }, (result) => ({ ...result, codes: [] }));
  }

  public async disableCode(input: { readonly tenantId: string; readonly codeId: string; readonly operatorId: string; readonly reason: string; readonly idempotencyKey: string }): Promise<void> {
    await this.withReceipt('RedeemDisableCode', input.tenantId, input.idempotencyKey, { ...input, idempotencyKey: undefined }, emptyResultSchema, async () => {
      const [result] = await this.connection.execute<ResultSetHeader>(`UPDATE entitlement_redeem_code SET status = 'disabled' WHERE tenant_id = $1 AND code_id = $2 AND status = 'issued'`, [input.tenantId, input.codeId]);
      if ((result as { affectedRows: number }).affectedRows !== 1) throw new Error('billing.redeem_code_not_active');
      await this.audit(input.tenantId, input.operatorId, 'redeem_code_disabled', input.operatorId, input.codeId, input.reason, {});
      return {};
    });
  }

  private async audit(tenantId: string, operatorId: string, action: string, subjectId: string, resourceId: string, reason: string, payload: object): Promise<void> {
    await this.connection.execute(`INSERT INTO entitlement_audit_event (audit_event_id, tenant_id, operator_id, action, subject_id, resource_type, resource_id, reason, payload_json) VALUES ($1, $2, $3, $4, $5, 'redeem', $6, $7, $8)`, [randomUUID(), tenantId, operatorId, action, subjectId, resourceId, reason, JSON.stringify(payload)]);
  }

  private async withReceipt<T>(command: string, tenantId: string, key: string, payload: object, schema: ZodType<T>, work: () => Promise<T>, persist: (result: T) => T = (result) => result): Promise<T> {
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await this.connection.beginTransaction();
    try {
      const [rows] = await this.connection.execute<Receipt[]>(`SELECT payload_hash, result_json, status FROM entitlement_command_receipt WHERE tenant_id = $1 AND command_name = $2 AND idempotency_key = $3 FOR UPDATE`, [tenantId, command, key]);
      const prior = rows[0];
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
        if (prior.status === 'processing' || prior.status === 'unknown') throw new Error('billing.command_unknown');
        if (prior.status !== 'succeeded' || prior.result_json === null) throw new Error('billing.command_failed');
        const result = parsePersistedJson(prior.result_json, schema, 'billing.command_result_invalid');
        await this.connection.commit();
        return result;
      }
      const receiptId = randomUUID();
      await this.connection.execute(`INSERT INTO entitlement_command_receipt (receipt_id, tenant_id, command_name, idempotency_key, payload_hash, status) VALUES ($1, $2, $3, $4, $5, 'processing')`, [receiptId, tenantId, command, key, payloadHash]);
      const result = await work();
      await this.connection.execute(`UPDATE entitlement_command_receipt SET status = 'succeeded', result_json = $1 WHERE receipt_id = $2`, [JSON.stringify(persist(result)), receiptId]);
      await this.connection.commit(); return result;
    } catch (error) { await this.connection.rollback(); throw error; }
  }
}
