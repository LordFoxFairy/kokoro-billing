import { randomUUID } from 'node:crypto';
import type { SqlConnection, ResultSetHeader, RowDataPacket } from '../../database.js';
import { hashRedeemCode } from '../../../../application/credit/services/redeem-code.js';

export type RedeemInput = { readonly tenantId: string; readonly subjectId: string; readonly code: string; readonly idempotencyKey: string };
export type RedeemResult = { readonly redemptionId: string; readonly grantId: string; readonly amountMicros: string; readonly programKey: string };

export class RedeemService {
  public constructor(private readonly connection: SqlConnection, private readonly secret: string) {}

  public async redeem(input: RedeemInput): Promise<RedeemResult> {
    const hash = hashRedeemCode(input.code, this.secret);
    await this.connection.beginTransaction();
    try {
      const [prior] = await this.connection.execute<RowDataPacket[]>(
        `SELECT r.redemption_id, r.credit_grant_id, r.amount_micros, c.program_key
           FROM entitlement_redeem r JOIN entitlement_redeem_campaign c ON c.campaign_id = r.campaign_id AND c.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND r.recipient_id = $2 AND r.idempotency_key = $3 FOR UPDATE`,
        [input.tenantId, input.subjectId, input.idempotencyKey],
      );
      if (prior[0]) {
        const row = prior[0] as { redemption_id: string; credit_grant_id: string; amount_micros: string | number; program_key: string };
        await this.connection.commit();
        return { redemptionId: row.redemption_id, grantId: row.credit_grant_id, amountMicros: String(row.amount_micros), programKey: row.program_key };
      }
      const [codes] = await this.connection.execute<RowDataPacket[]>(
        `SELECT c.code_id, c.campaign_id, c.status, p.program_key, p.credit_micros, p.max_redemptions, p.redeemed_count, p.status AS campaign_status, p.starts_at, p.ends_at
           FROM entitlement_redeem_code c JOIN entitlement_redeem_campaign p ON p.campaign_id = c.campaign_id AND p.tenant_id = c.tenant_id
          WHERE c.tenant_id = $1 AND c.code_hash = $2 FOR UPDATE`, [input.tenantId, hash]);
      const code = codes[0] as { code_id: string; campaign_id: string; status: string; program_key: string; credit_micros: string | number; max_redemptions: number; redeemed_count: number; campaign_status: string; starts_at: Date; ends_at: Date | null } | undefined;
      const now = Date.now();
      if (!code || code.status !== 'issued' || code.campaign_status !== 'active' || new Date(code.starts_at).getTime() > now || (code.ends_at && new Date(code.ends_at).getTime() <= now) || code.redeemed_count >= code.max_redemptions) throw new Error('billing.redeem_invalid');
      const [accounts] = await this.connection.execute<RowDataPacket[]>(`SELECT credit_account_id, subject_id FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2 FOR UPDATE`, [input.tenantId, input.subjectId]);
      let accountId = String(accounts[0]?.credit_account_id ?? '');
      if (!accountId) {
        accountId = randomUUID();
        await this.connection.execute(`INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id) VALUES ($1, $2, $3)`, [accountId, input.tenantId, input.subjectId]);
      }
      const redemptionId = randomUUID();
      const grantId = randomUUID();
      const amount = String(code.credit_micros);
      await this.connection.execute(`INSERT INTO entitlement_redeem (redemption_id, tenant_id, code_id, campaign_id, recipient_id, idempotency_key, credit_grant_id, amount_micros) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [redemptionId, input.tenantId, code.code_id, code.campaign_id, input.subjectId, input.idempotencyKey, grantId, amount]);
      const [codeUpdate] = await this.connection.execute<ResultSetHeader>(`UPDATE entitlement_redeem_code SET status = 'redeemed', redeemed_by = $1, redeemed_at = CURRENT_TIMESTAMP(3) WHERE tenant_id = $2 AND code_id = $3 AND status = 'issued'`, [input.subjectId, input.tenantId, code.code_id]);
      if (codeUpdate.affectedRows !== 1) throw new Error('billing.redeem_invalid');
      const [campaignUpdate] = await this.connection.execute<ResultSetHeader>(`UPDATE entitlement_redeem_campaign SET redeemed_count = redeemed_count + 1 WHERE tenant_id = $1 AND campaign_id = $2 AND redeemed_count < max_redemptions`, [input.tenantId, code.campaign_id]);
      if (campaignUpdate.affectedRows !== 1) throw new Error('billing.redeem_invalid');
      await this.connection.execute(`INSERT INTO entitlement_credit_grant (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key, original_micros, remaining_micros, effective_at) VALUES ($1, $2, $3, 'redeem', $4, $5, $6, $7, CURRENT_TIMESTAMP(3))`, [grantId, input.tenantId, accountId, redemptionId, code.program_key, amount, amount]);
      const [seq] = await this.connection.execute<RowDataPacket[]>(`SELECT COALESCE(MAX(journal_seq), 0) AS n FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2`, [input.tenantId, accountId]);
      const journalSeq = (BigInt(String((seq[0] as { n: string | number }).n)) + 1n).toString();
      await this.connection.execute(`INSERT INTO entitlement_credit_journal (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref) VALUES ($1, $2, $3, $4, 'grant', $5, 'redeem', $6)`, [randomUUID(), input.tenantId, accountId, journalSeq, amount, redemptionId]);
      const [accountUpdate] = await this.connection.execute<ResultSetHeader>(`UPDATE entitlement_credit_account SET available_micros = available_micros + $1, generation = generation + 1 WHERE tenant_id = $2 AND credit_account_id = $3`, [amount, input.tenantId, accountId]);
      if (accountUpdate.affectedRows !== 1) throw new Error('billing.credit_projection_drift');
      await this.connection.execute(`INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES ($1, $2, 'redeem', $3, 'RedeemCommitted', $4)`, [randomUUID(), input.tenantId, redemptionId, JSON.stringify({ redemptionId, grantId, programKey: code.program_key })]);
      await this.connection.commit();
      return { redemptionId, grantId, amountMicros: amount, programKey: code.program_key };
    } catch (error) { await this.connection.rollback(); throw error; }
  }
}
