import { randomUUID } from 'node:crypto';
import type { SqlConnection, ResultSetHeader, RowDataPacket } from '../../database.js';

export type RecordSettlementInput = {
  readonly settlementId: string;
  readonly tenantId: string;
  readonly externalPaymentRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Provider namespace for the external reference; internal callers default to `internal`. */
  readonly provider?: string;
  readonly providerEventId?: string;
  readonly checkoutId?: string;
};

export type FulfillSettlementInput = {
  readonly settlementId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly subjectId: string;
  readonly programKey: string;
  readonly grantMicros: number;
};

export type FulfillmentResult = {
  readonly fulfillmentId: string;
  readonly grantId: string;
  readonly journalId: string;
};

type SettlementRow = RowDataPacket & { settlement_id: string; tenant_id: string; provider: string; external_payment_ref: string; amount_minor: number; currency: string; status: string };
type FulfillmentRow = RowDataPacket & { fulfillment_id: string; credit_grant_id: string; journal_id: string };

export class BillingSettlementService {
  public constructor(private readonly connection: SqlConnection) {}

  public async recordSettlement(input: RecordSettlementInput): Promise<void> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RangeError('amountMinor must be positive');
    const provider = input.provider ?? 'internal';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(provider)) throw new RangeError('provider must be a normalized identifier');
    await this.connection.beginTransaction();
    try {
      await this.connection.execute(
        `INSERT INTO payment_settlement
          (settlement_id, tenant_id, provider_event_id, checkout_id, provider, external_payment_ref, amount_minor, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded')
          ON CONFLICT DO NOTHING`,
        [input.settlementId, input.tenantId, input.providerEventId ?? null, input.checkoutId ?? null, provider, input.externalPaymentRef, input.amountMinor, input.currency],
      );
      const [rows] = await this.connection.execute<SettlementRow[]>(
        `SELECT settlement_id, tenant_id, provider, external_payment_ref, amount_minor, currency, status
           FROM payment_settlement WHERE tenant_id = $1 AND provider = $2 AND external_payment_ref = $3 FOR UPDATE`,
        [input.tenantId, provider, input.externalPaymentRef],
      );
      const row = rows[0];
      if (!row) throw new Error('billing.settlement_not_found');
      if (row.settlement_id !== input.settlementId || row.tenant_id !== input.tenantId || row.provider !== provider || row.external_payment_ref !== input.externalPaymentRef || String(row.amount_minor) !== String(input.amountMinor) || row.currency !== input.currency) {
        throw new Error('billing.idempotency_conflict');
      }
      await this.connection.execute(
        `INSERT INTO payment_outbox
          (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'payment_settlement', $3, 'PaymentSettlementRecorded', $4)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), input.tenantId, input.settlementId, JSON.stringify({ settlementId: input.settlementId, provider, externalPaymentRef: input.externalPaymentRef, amountMinor: input.amountMinor, currency: input.currency })],
      );
      await this.connection.commit();
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  public async fulfillSettlement(input: FulfillSettlementInput): Promise<FulfillmentResult> {
    if (!Number.isSafeInteger(input.grantMicros) || input.grantMicros <= 0) throw new RangeError('grantMicros must be positive');
    await this.connection.beginTransaction();
    try {
      const [settlements] = await this.connection.execute<SettlementRow[]>(
        `SELECT settlement_id, tenant_id, provider, external_payment_ref, amount_minor, currency, status
           FROM payment_settlement WHERE settlement_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.settlementId, input.tenantId],
      );
      const settlement = settlements[0];
      if (!settlement) throw new Error('billing.settlement_not_found');
      if (settlement.status !== 'succeeded') throw new Error('billing.settlement_not_succeeded');

      const [existing] = await this.connection.execute<FulfillmentRow[]>(
        `SELECT f.fulfillment_id, g.credit_grant_id, j.journal_id,
                a.subject_id, a.program_key, a.quantity_micros,
                g.credit_account_id, g.original_micros
           FROM entitlement_fulfillment f
           JOIN entitlement_acquisition a ON a.acquisition_id = f.acquisition_id AND a.tenant_id = f.tenant_id
           JOIN entitlement_credit_grant g ON g.tenant_id = a.tenant_id AND g.source_ref = a.source_ref AND g.source_kind = 'payment_settlement'
           JOIN entitlement_credit_journal j ON j.tenant_id = a.tenant_id AND j.source_ref = a.source_ref AND j.source_kind = 'payment_settlement'
          WHERE a.tenant_id = $1 AND a.source_kind = 'payment_settlement' AND a.source_ref = $2
          LIMIT 1`,
        [input.tenantId, input.settlementId],
      );
      if (existing[0]) {
        const prior = existing[0] as FulfillmentRow & { subject_id: string; program_key: string; quantity_micros: string | number; credit_account_id: string; original_micros: string | number };
        if (prior.subject_id !== input.subjectId || prior.program_key !== input.programKey || String(prior.quantity_micros) !== String(input.grantMicros) || prior.credit_account_id !== input.accountId || String(prior.original_micros) !== String(input.grantMicros)) throw new Error('billing.idempotency_conflict');
        await this.connection.commit();
        return {
          fulfillmentId: prior.fulfillment_id,
          grantId: prior.credit_grant_id,
          journalId: prior.journal_id,
        };
      }

      await this.connection.execute(
        `INSERT INTO entitlement_credit_account
          (credit_account_id, tenant_id, subject_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [input.accountId, input.tenantId, input.subjectId],
      );
      const [accounts] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_account_id FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2 FOR UPDATE`,
        [input.tenantId, input.subjectId],
      );
      const account = accounts[0] as { credit_account_id: string } | undefined;
      if (!account || account.credit_account_id !== input.accountId) throw new Error('billing.credit_account_mismatch');

      const acquisitionId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_acquisition
          (acquisition_id, tenant_id, subject_id, source_kind, source_ref, program_key, quantity_micros)
         VALUES ($1, $2, $3, 'payment_settlement', $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [acquisitionId, input.tenantId, input.subjectId, input.settlementId, input.programKey, input.grantMicros],
      );
      const [acquisitions] = await this.connection.execute<RowDataPacket[]>(
        `SELECT acquisition_id FROM entitlement_acquisition
          WHERE tenant_id = $1 AND source_kind = 'payment_settlement' AND source_ref = $2 AND program_key = $3 FOR UPDATE`,
        [input.tenantId, input.settlementId, input.programKey],
      );
      const acquisition = acquisitions[0] as { acquisition_id: string } | undefined;
      if (!acquisition) throw new Error('billing.acquisition_not_found');

      const fulfillmentId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_fulfillment
          (fulfillment_id, tenant_id, acquisition_id, status, committed_at)
         VALUES ($1, $2, $3, 'committed', CURRENT_TIMESTAMP(3))
         ON CONFLICT DO NOTHING`,
        [fulfillmentId, input.tenantId, acquisition.acquisition_id],
      );
      const [fulfillments] = await this.connection.execute<RowDataPacket[]>(
        `SELECT fulfillment_id FROM entitlement_fulfillment WHERE tenant_id = $1 AND acquisition_id = $2 FOR UPDATE`,
        [input.tenantId, acquisition.acquisition_id],
      );
      const fulfillment = fulfillments[0] as { fulfillment_id: string } | undefined;
      if (!fulfillment) throw new Error('billing.fulfillment_not_found');

      const grantId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_credit_grant
          (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key,
           original_micros, remaining_micros, effective_at)
         VALUES ($1, $2, $3, 'payment_settlement', $4, $5, $6, $7, CURRENT_TIMESTAMP(3))
         ON CONFLICT DO NOTHING`,
        [grantId, input.tenantId, input.accountId, input.settlementId, input.programKey, input.grantMicros, input.grantMicros],
      );
      const [grants] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_grant_id FROM entitlement_credit_grant
          WHERE tenant_id = $1 AND source_kind = 'payment_settlement' AND source_ref = $2 AND program_key = $3 FOR UPDATE`,
        [input.tenantId, input.settlementId, input.programKey],
      );
      const grant = grants[0] as { credit_grant_id: string } | undefined;
      if (!grant) throw new Error('billing.credit_grant_not_found');

      const [sequences] = await this.connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(MAX(journal_seq), 0) AS journal_seq FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2`,
        [input.tenantId, input.accountId],
      );
      const nextSequence = (BigInt(String((sequences[0] as { journal_seq: number | string }).journal_seq)) + 1n).toString();
      const journalId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_credit_journal
          (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref)
         VALUES ($1, $2, $3, $4, 'grant', $5, 'payment_settlement', $6)
         ON CONFLICT DO NOTHING`,
        [journalId, input.tenantId, input.accountId, nextSequence, input.grantMicros, input.settlementId],
      );
      const [journals] = await this.connection.execute<RowDataPacket[]>(
        `SELECT journal_id FROM entitlement_credit_journal
          WHERE tenant_id = $1 AND source_kind = 'payment_settlement' AND source_ref = $2 AND entry_kind = 'grant' FOR UPDATE`,
        [input.tenantId, input.settlementId],
      );
      const journal = journals[0] as { journal_id: string } | undefined;
      if (!journal) throw new Error('billing.journal_not_found');

      const [accountUpdate] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_account
            SET available_micros = available_micros + $1, generation = generation + 1
          WHERE tenant_id = $2 AND credit_account_id = $3`,
        [input.grantMicros, input.tenantId, input.accountId],
      );
      if (accountUpdate.affectedRows !== 1) throw new Error('billing.credit_projection_drift');
      await this.connection.execute(
        `INSERT INTO entitlement_outbox
          (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'fulfillment', $3, 'EntitlementFulfilled', $4)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), input.tenantId, fulfillment.fulfillment_id, JSON.stringify({ settlementId: input.settlementId, grantId: grant.credit_grant_id })],
      );
      await this.connection.commit();
      return { fulfillmentId: fulfillment.fulfillment_id, grantId: grant.credit_grant_id, journalId: journal.journal_id };
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
