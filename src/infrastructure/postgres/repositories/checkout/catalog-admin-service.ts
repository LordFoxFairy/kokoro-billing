import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { SqlConnection, ResultSetHeader, RowDataPacket } from '../../database.js';
import type { CatalogPlan } from './catalog-service.js';
import { z } from 'zod';
import { parsePersistedJson } from '../../json.js';

export type PublishCatalogPlanInput = {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly offerKey: string;
  readonly name: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly creditMicros: number;
  readonly billingInterval: CatalogPlan['billingInterval'];
  readonly reason: string;
  readonly idempotencyKey: string;
};

const catalogPlanSchema = z.object({
  id: z.string().min(1), key: z.string().min(1), name: z.string().min(1), currency: z.string().length(3),
  amountMinor: z.string().regex(/^\d+$/u), creditMicros: z.string().regex(/^\d+$/u), billingInterval: z.enum(['once', 'month', 'year']),
}).strict();

/** Admin-only catalog command: every published price is a new immutable revision. */
export class CatalogAdminService {
  public constructor(private readonly connection: SqlConnection) {}

  public async publishPlan(input: PublishCatalogPlanInput): Promise<CatalogPlan> {
    await this.connection.beginTransaction();
    try {
      const payloadHash = createHash('sha256').update(JSON.stringify({ ...input, idempotencyKey: undefined })).digest('hex');
      const [receiptInsert] = await this.connection.execute<ResultSetHeader>(
        `INSERT INTO entitlement_command_receipt (receipt_id, tenant_id, command_name, idempotency_key, payload_hash, status)
         VALUES ($1, $2, 'catalog.plan.publish', $3, $4, 'processing')
         ON CONFLICT DO NOTHING`,
        [randomUUID(), input.tenantId, input.idempotencyKey, payloadHash],
      );
      const [receipts] = await this.connection.execute<RowDataPacket[]>(
        `SELECT payload_hash, status, result_json FROM entitlement_command_receipt
          WHERE tenant_id = $1 AND command_name = 'catalog.plan.publish' AND idempotency_key = $2 FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      );
      const receipt = receipts[0] as { payload_hash: string; status: string; result_json: string | null } | undefined;
      if (!receipt) throw new Error('billing.command_receipt_not_found');
      if (receipt.payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
      if (receipt.status === 'succeeded' && receipt.result_json !== null) {
        await this.connection.commit();
        return parsePersistedJson(receipt.result_json, catalogPlanSchema, 'billing.command_result_invalid');
      }
      if (receiptInsert.affectedRows !== 1 && receipt.status === 'processing') throw new Error('billing.command_unknown');
      if (receipt.status === 'unknown') throw new Error('billing.command_unknown');
      if (receipt.status === 'failed') throw new Error('billing.command_failed');
      if (receipt.status !== 'processing') throw new Error('billing.command_unknown');
      await this.connection.execute(
        `INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (tenant_id, offer_key) DO UPDATE SET status = 'active'`,
        [randomUUID(), input.tenantId, input.offerKey],
      );
      const [offers] = await this.connection.execute<RowDataPacket[]>(
        `SELECT offer_id FROM entitlement_offer WHERE tenant_id = $1 AND offer_key = $2 FOR UPDATE`,
        [input.tenantId, input.offerKey],
      );
      const offerId = String((offers[0] as { offer_id: string } | undefined)?.offer_id ?? '');
      if (offerId === '') throw new Error('billing.offer_not_found');
      const [revisions] = await this.connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(MAX(revision), 0) AS revision FROM entitlement_offer_revision WHERE tenant_id = $1 AND offer_id = $2`,
        [input.tenantId, offerId],
      );
      const revision = Number((revisions[0] as { revision: number } | undefined)?.revision ?? 0) + 1;
      const revisionId = randomUUID();
      const result: CatalogPlan = { id: revisionId, key: input.offerKey, name: input.name, currency: input.currency, amountMinor: String(input.amountMinor), creditMicros: String(input.creditMicros), billingInterval: input.billingInterval };
      await this.connection.execute(
        `UPDATE entitlement_command_receipt SET status = 'succeeded', result_json = $1 WHERE tenant_id = $2 AND command_name = 'catalog.plan.publish' AND idempotency_key = $3`,
        [JSON.stringify(result), input.tenantId, input.idempotencyKey],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, offerId, input.tenantId, revision, input.name, input.currency, input.amountMinor, input.creditMicros, input.billingInterval],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_audit_event
          (audit_event_id, tenant_id, operator_id, action, subject_id, resource_type, resource_id, reason, payload_json)
         VALUES ($1, $2, $3, 'catalog.plan.publish', NULL, 'offer_revision', $4, $5, jsonb_build_object('offerKey', $6::text, 'revision', $7::int))`,
        [randomUUID(), input.tenantId, input.operatorId, revisionId, input.reason, input.offerKey, revision],
      );
      await this.connection.commit();
      return result;
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
