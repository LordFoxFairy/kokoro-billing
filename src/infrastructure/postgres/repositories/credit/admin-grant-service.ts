import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, ResultSetHeader, RowDataPacket } from '../../database.js';
import { z } from 'zod';
import { parsePersistedJson } from '../../json.js';

export type AdminGrantInput = {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly accountId: string;
  readonly amountMicros: number;
  readonly programKey: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
};

export type AdminGrantResult = { readonly grantId: string; readonly journalId: string };
const adminGrantResultSchema = z.object({ grantId: z.string().min(1), journalId: z.string().min(1) }).strict();

export class AdminGrantService {
  public constructor(private readonly connection: SqlConnection) {}

  public async grant(input: AdminGrantInput): Promise<AdminGrantResult> {
    if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0) throw new RangeError('amountMicros must be positive');
    if (input.reason.trim() === '') throw new Error('billing.admin_reason_required');
    const payloadHash = createHash('sha256').update(JSON.stringify({ ...input, operatorId: undefined })).digest('hex');
    await this.connection.beginTransaction();
    try {
      const [prior] = await this.connection.execute<RowDataPacket[]>(
        `SELECT payload_hash, result_json, status FROM entitlement_command_receipt
          WHERE tenant_id = $1 AND command_name = 'AdminGrant' AND idempotency_key = $2 FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior[0]) {
        const existing = prior[0] as { payload_hash: string; result_json: string | AdminGrantResult | null; status: string };
        if (existing.payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
        if (existing.status === 'processing') throw new Error('billing.command_unknown');
        if (existing.status === 'unknown') throw new Error('billing.command_unknown');
        if (existing.status !== 'succeeded' || existing.result_json === null) throw new Error('billing.command_failed');
        const stored = existing.result_json;
        const result = parsePersistedJson(stored, adminGrantResultSchema, 'billing.command_result_invalid');
        await this.connection.commit();
        return result;
      }
      const receiptId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_command_receipt
          (receipt_id, tenant_id, command_name, idempotency_key, payload_hash, status)
         VALUES ($1, $2, 'AdminGrant', $3, $4, 'processing')`,
        [receiptId, input.tenantId, input.idempotencyKey, payloadHash],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [input.accountId, input.tenantId, input.subjectId],
      );
      const [accounts] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_account_id, subject_id FROM entitlement_credit_account WHERE credit_account_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.accountId, input.tenantId],
      );
      const account = accounts[0] as { credit_account_id: string; subject_id: string } | undefined;
      if (!account) throw new Error('billing.credit_account_not_found');
      if (account.subject_id !== input.subjectId) throw new Error('billing.credit_account_mismatch');
      const grantId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_credit_grant
          (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key,
           original_micros, remaining_micros, effective_at)
         VALUES ($1, $2, $3, 'admin_grant', $4, $5, $6, $7, CURRENT_TIMESTAMP(3))`,
        [grantId, input.tenantId, input.accountId, receiptId, input.programKey, input.amountMicros, input.amountMicros],
      );
      const [sequences] = await this.connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(MAX(journal_seq), 0) AS journal_seq FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2`,
        [input.tenantId, input.accountId],
      );
      const journalId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_credit_journal
          (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref)
         VALUES ($1, $2, $3, $4, 'adjustment', $5, 'admin_grant', $6)`,
        [journalId, input.tenantId, input.accountId, (BigInt(String((sequences[0] as { journal_seq: number | string }).journal_seq)) + 1n).toString(), input.amountMicros, receiptId],
      );
      const [accountUpdate] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_account SET available_micros = available_micros + $1, generation = generation + 1 WHERE tenant_id = $2 AND credit_account_id = $3`,
        [input.amountMicros, input.tenantId, input.accountId],
      );
      if (accountUpdate.affectedRows !== 1) throw new Error('billing.credit_projection_drift');
      const result = { grantId, journalId };
      await this.connection.execute(
        `UPDATE entitlement_command_receipt SET status = 'succeeded', result_json = $1 WHERE tenant_id = $2 AND receipt_id = $3`,
        [JSON.stringify(result), input.tenantId, receiptId],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_audit_event
          (audit_event_id, tenant_id, operator_id, action, subject_id, resource_type, resource_id, reason, payload_json)
         VALUES ($1, $2, $3, 'admin_grant', $4, 'credit_grant', $5, $6, $7)`,
        [randomUUID(), input.tenantId, input.operatorId, input.subjectId, grantId, input.reason, JSON.stringify({ amountMicros: input.amountMicros, programKey: input.programKey, idempotencyKey: input.idempotencyKey })],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_outbox
          (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'credit_grant', $3, 'AdminCreditGranted', $4)`,
        [randomUUID(), input.tenantId, grantId, JSON.stringify({ grantId, operatorId: input.operatorId, reason: input.reason })],
      );
      await this.connection.commit();
      return result;
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
