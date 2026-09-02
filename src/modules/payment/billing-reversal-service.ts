import { randomUUID } from 'node:crypto';
import type { Connection, ResultSetHeader, RowDataPacket } from '../../application/ports.js';
import { createHash } from 'node:crypto';
import { readSafeInteger } from '../../infrastructure/postgres/safe-integer.js';

export type RecordReversalInput = {
  readonly tenantId: string;
  readonly settlementId: string;
  /** Provider namespace for the external refund reference; defaults to the settlement provider. */
  readonly provider?: string;
  readonly externalReversalRef: string;
  readonly amountMinor: number;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly operatorId?: string;
};

export type ReverseCreditsInput = {
  readonly tenantId: string;
  readonly reversalId: string;
  readonly settlementId: string;
  readonly accountId: string;
  /** Omit for provider refunds; the service computes a serialized proportional allocation. */
  readonly amountMicros?: number;
};

export type ReversalResult = {
  readonly fulfillmentReversalId: string;
  readonly journalId: string;
};

export class BillingReversalService {
  public constructor(private readonly connection: Connection) {}

  public async recordReversal(input: RecordReversalInput): Promise<string> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RangeError('amountMinor must be positive');
    const reversalId = randomUUID();
    const payloadHash = createHash('sha256').update(JSON.stringify({
      settlementId: input.settlementId,
      provider: input.provider ?? 'settlement-provider',
      externalReversalRef: input.externalReversalRef,
      amountMinor: input.amountMinor,
      reason: input.reason,
    })).digest('hex');
    await this.connection.beginTransaction();
    try {
      const [settlements] = await this.connection.execute<RowDataPacket[]>(
        `SELECT provider, amount_minor FROM payment_settlement WHERE tenant_id = $1 AND settlement_id = $2 FOR SHARE`,
        [input.tenantId, input.settlementId],
      );
      const settlement = settlements[0] as { provider: string; amount_minor: number | string } | undefined;
      if (!settlement) throw new Error('billing.settlement_not_found');
      const settlementAmountMinor = readSafeInteger(settlement.amount_minor, 'settlement_amount_minor');
      if (input.amountMinor > settlementAmountMinor) throw new Error('billing.reversal_amount_exceeds_settlement');
      const provider = input.provider ?? settlement.provider;
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(provider)) throw new RangeError('provider must be a normalized identifier');
      const [receipts] = await this.connection.execute<RowDataPacket[]>(
        `SELECT payload_hash, status, result_json
           FROM payment_command_receipt
          WHERE tenant_id = $1 AND command_name = 'PaymentReversal' AND idempotency_key = $2
          FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      );
      const receipt = receipts[0] as { payload_hash: string; status: string; result_json: string | null } | undefined;
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
        if (receipt.status === 'processing') throw new Error('billing.command_in_progress');
        if (receipt.status === 'unknown') throw new Error('billing.command_unknown');
        if (receipt.status !== 'succeeded' || receipt.result_json === null) throw new Error('billing.command_failed');
        const result = typeof receipt.result_json === 'string' ? JSON.parse(receipt.result_json) as { reversalId: string } : receipt.result_json as { reversalId: string };
        await this.connection.commit();
        return result.reversalId;
      }
      await this.connection.execute(
        `INSERT INTO payment_command_receipt
          (receipt_id, tenant_id, command_name, idempotency_key, payload_hash, status)
         VALUES ($1, $2, 'PaymentReversal', $3, $4, 'processing')`,
        [randomUUID(), input.tenantId, input.idempotencyKey, payloadHash],
      );
      const [prior] = await this.connection.execute<RowDataPacket[]>(
        `SELECT reversal_id, settlement_id, provider, amount_minor, reason
           FROM payment_reversal WHERE tenant_id = $1 AND provider = $2 AND external_reversal_ref = $3 FOR UPDATE`,
        [input.tenantId, provider, input.externalReversalRef],
      );
      const [priorTotals] = await this.connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor
           FROM payment_reversal
          WHERE tenant_id = $1 AND settlement_id = $2 AND provider = $3 AND external_reversal_ref <> $4 AND status = 'succeeded'`,
        [input.tenantId, input.settlementId, provider, input.externalReversalRef],
      );
      const priorAmountMinor = readSafeInteger((priorTotals[0] as { amount_minor: number | string } | undefined)?.amount_minor ?? 0, 'prior_reversal_amount_minor');
      if (priorAmountMinor + input.amountMinor > settlementAmountMinor) throw new Error('billing.reversal_amount_exceeds_settlement');
      if (prior[0]) {
        const row = prior[0] as { reversal_id: string; settlement_id: string; provider: string; amount_minor: number; reason: string };
        if (row.settlement_id !== input.settlementId || row.provider !== provider || readSafeInteger(row.amount_minor, 'reversal_amount_minor') !== input.amountMinor || row.reason !== input.reason) throw new Error('billing.idempotency_conflict');
        await this.writeReversalOutbox(input.tenantId, row.reversal_id, input.settlementId, input.amountMinor, input.reason);
        await this.markReceiptSucceeded(input.tenantId, input.idempotencyKey, row.reversal_id);
        await this.connection.commit();
        return row.reversal_id;
      }
      await this.connection.execute(
        `INSERT INTO payment_reversal
          (reversal_id, tenant_id, settlement_id, provider, external_reversal_ref, amount_minor, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'succeeded')
          ON CONFLICT DO NOTHING`,
        [reversalId, input.tenantId, input.settlementId, provider, input.externalReversalRef, input.amountMinor, input.reason],
      );
      if (input.operatorId) {
        await this.connection.execute(
          `INSERT INTO entitlement_audit_event
            (audit_event_id, tenant_id, operator_id, action, resource_type, resource_id, reason, payload_json)
           VALUES ($1, $2, $3, 'admin_refund', 'payment_reversal', $4, $5, $6)`,
          [randomUUID(), input.tenantId, input.operatorId, reversalId, input.reason, JSON.stringify({ settlementId: input.settlementId, amountMinor: input.amountMinor, externalReversalRef: input.externalReversalRef })],
        );
      }
      const [rows] = await this.connection.execute<(RowDataPacket & { reversal_id: string; settlement_id: string; provider: string; amount_minor: number; reason: string })[]>(
        `SELECT reversal_id, settlement_id, provider, amount_minor, reason
           FROM payment_reversal WHERE tenant_id = $1 AND provider = $2 AND external_reversal_ref = $3 FOR UPDATE`,
        [input.tenantId, provider, input.externalReversalRef],
      );
      const row = rows[0];
      if (!row) throw new Error('billing.reversal_not_found');
      if (row.settlement_id !== input.settlementId || row.provider !== provider || readSafeInteger(row.amount_minor, 'reversal_amount_minor') !== input.amountMinor || row.reason !== input.reason) {
        throw new Error('billing.idempotency_conflict');
      }
      await this.writeReversalOutbox(input.tenantId, row.reversal_id, input.settlementId, input.amountMinor, input.reason);
      await this.markReceiptSucceeded(input.tenantId, input.idempotencyKey, row.reversal_id);
      await this.connection.commit();
      return row.reversal_id;
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  private async markReceiptSucceeded(tenantId: string, idempotencyKey: string, reversalId: string): Promise<void> {
    await this.connection.execute(
      `UPDATE payment_command_receipt
          SET status = 'succeeded', result_json = $1
        WHERE tenant_id = $2 AND command_name = 'PaymentReversal' AND idempotency_key = $3`,
      [JSON.stringify({ reversalId }), tenantId, idempotencyKey],
    );
  }

  private async writeReversalOutbox(tenantId: string, reversalId: string, settlementId: string, amountMinor: number, reason: string): Promise<void> {
    await this.connection.execute(
      `INSERT INTO payment_outbox
        (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
       VALUES ($1, $2, 'payment_reversal', $3, 'PaymentReversalRecorded', $4)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, reversalId, JSON.stringify({ reversalId, settlementId, amountMinor, reason })],
    );
  }

  public async reverseCredits(input: ReverseCreditsInput): Promise<ReversalResult> {
    if (input.amountMicros !== undefined && (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0)) throw new RangeError('amountMicros must be positive');
    await this.connection.beginTransaction();
    try {
      const [reversals] = await this.connection.execute<RowDataPacket[]>(
        `SELECT reversal_id, settlement_id, status FROM payment_reversal
          WHERE reversal_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.reversalId, input.tenantId],
      );
      const reversal = reversals[0] as { reversal_id: string; settlement_id: string; status: string } | undefined;
      if (!reversal) throw new Error('billing.reversal_not_found');
      if (reversal.settlement_id !== input.settlementId) throw new Error('billing.reversal_settlement_mismatch');
      if (reversal.status !== 'succeeded') throw new Error('billing.reversal_not_succeeded');

      const [existing] = await this.connection.execute<RowDataPacket[]>(
        `SELECT fulfillment_reversal_id, journal_id
           FROM entitlement_fulfillment_reversal r
           JOIN entitlement_credit_journal j ON j.tenant_id = r.tenant_id AND j.source_kind = 'payment_reversal' AND j.source_ref = r.payment_reversal_id
          WHERE r.tenant_id = $1 AND r.payment_reversal_id = $2`,
        [input.tenantId, input.reversalId],
      );
      const prior = existing[0] as { fulfillment_reversal_id: string; journal_id: string } | undefined;
      if (prior) {
        await this.connection.commit();
        return { fulfillmentReversalId: prior.fulfillment_reversal_id, journalId: prior.journal_id };
      }

      const [grants] = await this.connection.execute<RowDataPacket[]>(
        `SELECT g.credit_grant_id, g.original_micros, g.remaining_micros, f.fulfillment_id
           FROM entitlement_credit_grant g
           JOIN entitlement_acquisition a ON a.tenant_id = g.tenant_id AND a.source_kind = 'payment_settlement' AND a.source_ref = g.source_ref
           JOIN entitlement_fulfillment f ON f.tenant_id = a.tenant_id AND f.acquisition_id = a.acquisition_id
          WHERE g.tenant_id = $1 AND g.credit_account_id = $2 AND g.source_ref = $3
          FOR UPDATE`,
        [input.tenantId, input.accountId, input.settlementId],
      );
      const grant = grants[0] as { credit_grant_id: string; original_micros: number | string; remaining_micros: number | string; fulfillment_id: string } | undefined;
      if (!grant) throw new Error('billing.credit_grant_not_found');
      const remainingMicros = readSafeInteger(grant.remaining_micros, 'grant_remaining_micros');
      let amountMicros = input.amountMicros;
      if (amountMicros === undefined) {
        const [current] = await this.connection.execute<RowDataPacket[]>(
          `SELECT r.amount_minor, s.amount_minor AS settlement_amount_minor
             FROM payment_reversal r JOIN payment_settlement s ON s.tenant_id = r.tenant_id AND s.settlement_id = r.settlement_id
            WHERE r.tenant_id = $1 AND r.reversal_id = $2 FOR UPDATE`,
          [input.tenantId, input.reversalId],
        );
        const currentRow = current[0] as { amount_minor: number | string; settlement_amount_minor: number | string } | undefined;
        if (!currentRow) throw new Error('billing.reversal_not_found');
        const currentAmountMinor = readSafeInteger(currentRow.amount_minor, 'reversal_amount_minor');
        const settlementAmountMinor = readSafeInteger(currentRow.settlement_amount_minor, 'settlement_amount_minor');
        const [priorTotals] = await this.connection.execute<RowDataPacket[]>(
          `SELECT COALESCE(SUM(r.amount_minor), 0) AS prior_amount_minor,
                  COALESCE(SUM(f.amount_micros), 0) AS prior_credit_micros
             FROM payment_reversal r
             JOIN entitlement_fulfillment_reversal f ON f.tenant_id = r.tenant_id AND f.payment_reversal_id = r.reversal_id
            WHERE r.tenant_id = $1 AND r.settlement_id = $2 AND r.reversal_id <> $3 AND r.status = 'succeeded'`,
          [input.tenantId, input.settlementId, input.reversalId],
        );
        const totals = priorTotals[0] as { prior_amount_minor: number | string; prior_credit_micros: number | string } | undefined;
        const priorAmountMinor = BigInt(String(totals?.prior_amount_minor ?? 0));
        const priorCreditMicros = BigInt(String(totals?.prior_credit_micros ?? 0));
        const originalMicros = BigInt(String(grant.original_micros));
        const cumulativeAmountMinor = priorAmountMinor + BigInt(currentAmountMinor);
        if (settlementAmountMinor <= 0 || originalMicros <= 0n || cumulativeAmountMinor > BigInt(settlementAmountMinor)) throw new Error('billing.reversal_exposure');
        const targetCreditMicros = (originalMicros * cumulativeAmountMinor + BigInt(settlementAmountMinor) - 1n) / BigInt(settlementAmountMinor);
        const delta = targetCreditMicros - priorCreditMicros;
        if (delta <= 0n || delta > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('billing.reversal_rounding_exposure');
        amountMicros = Number(delta);
      }
      if (amountMicros === undefined || remainingMicros < amountMicros) throw new Error('billing.reversal_exposure');

      const fulfillmentReversalId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_fulfillment_reversal
          (fulfillment_reversal_id, tenant_id, fulfillment_id, payment_reversal_id, amount_micros, status)
         VALUES ($1, $2, $3, $4, $5, 'committed')`,
        [fulfillmentReversalId, input.tenantId, grant.fulfillment_id, input.reversalId, amountMicros],
      );
      const remaining = remainingMicros - amountMicros;
      const [grantUpdate] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_grant SET remaining_micros = $1, status = $2 WHERE tenant_id = $3 AND credit_grant_id = $4`,
        [remaining, remaining === 0 ? 'exhausted' : 'active', input.tenantId, grant.credit_grant_id],
      );
      if (grantUpdate.affectedRows !== 1) throw new Error('billing.reversal_exposure');

      const [sequences] = await this.connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(MAX(journal_seq), 0) AS journal_seq FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2`,
        [input.tenantId, input.accountId],
      );
      const journalSeq = (BigInt(String((sequences[0] as { journal_seq: number | string }).journal_seq)) + 1n).toString();
      const [accounts] = await this.connection.execute<RowDataPacket[]>(
        `SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND credit_account_id = $2 FOR UPDATE`,
        [input.tenantId, input.accountId],
      );
      const account = accounts[0] as { available_micros: number } | undefined;
      if (!account || readSafeInteger(account.available_micros, 'account_available_micros') < amountMicros) throw new Error('billing.reversal_exposure');
      const journalId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_credit_journal
          (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref)
         VALUES ($1, $2, $3, $4, 'reversal', $5, 'payment_reversal', $6)`,
        [journalId, input.tenantId, input.accountId, journalSeq, -amountMicros, input.reversalId],
      );
      const [accountUpdate] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_account
            SET available_micros = available_micros - $1, generation = generation + 1
          WHERE tenant_id = $2 AND credit_account_id = $3 AND available_micros >= $4`,
        [amountMicros, input.tenantId, input.accountId, amountMicros],
      );
      if (accountUpdate.affectedRows !== 1) throw new Error('billing.reversal_exposure');
      await this.connection.execute(
        `INSERT INTO entitlement_outbox
          (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'fulfillment_reversal', $3, 'EntitlementFulfillmentReversed', $4)`,
        [randomUUID(), input.tenantId, fulfillmentReversalId, JSON.stringify({ reversalId: input.reversalId, amountMicros })],
      );
      await this.connection.commit();
      return { fulfillmentReversalId, journalId };
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
