import { randomUUID } from "node:crypto";
import type {
  SqlConnection,
  ResultSetHeader,
  RowDataPacket,
} from "../../database.js";

export type SubscriptionGrantInput = {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly accountId: string;
  readonly periodId: string;
  readonly programKey: string;
  readonly amountMicros: number;
  readonly expiresAt: Date;
};

export type CreditGrantResult = {
  readonly grantId: string;
  readonly journalId: string;
};

/** Idempotent period -> acquisition -> fulfillment -> grant -> journal projection. */
export class SubscriptionGrantService {
  public constructor(private readonly connection: SqlConnection) {}

  public async grant(
    input: SubscriptionGrantInput,
  ): Promise<CreditGrantResult> {
    if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0)
      throw new RangeError("amountMicros must be positive");
    if (
      Number.isNaN(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= Date.now()
    )
      throw new Error("billing.subscription_period_expired");
    await this.connection.beginTransaction();
    try {
      await this.connection.execute(
        `INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [input.accountId, input.tenantId, input.subjectId],
      );
      const [accounts] = await this.connection.execute<
        (RowDataPacket & { credit_account_id: string })[]
      >(
        `SELECT credit_account_id FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2 FOR UPDATE`,
        [input.tenantId, input.subjectId],
      );
      if (accounts[0]?.credit_account_id !== input.accountId)
        throw new Error("billing.credit_account_mismatch");

      const acquisitionId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_acquisition
          (acquisition_id, tenant_id, subject_id, source_kind, source_ref, program_key, quantity_micros)
         VALUES ($1, $2, $3, 'subscription_period', $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          acquisitionId,
          input.tenantId,
          input.subjectId,
          input.periodId,
          input.programKey,
          input.amountMicros,
        ],
      );
      const [acquisitions] = await this.connection.execute<
        (RowDataPacket & { acquisition_id: string })[]
      >(
        `SELECT acquisition_id FROM entitlement_acquisition
          WHERE tenant_id = $1 AND source_kind = 'subscription_period' AND source_ref = $2 AND program_key = $3 FOR UPDATE`,
        [input.tenantId, input.periodId, input.programKey],
      );
      const acquisition = acquisitions[0];
      if (!acquisition) throw new Error("billing.acquisition_not_found");

      const fulfillmentId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_fulfillment (fulfillment_id, tenant_id, acquisition_id, status, committed_at)
         VALUES ($1, $2, $3, 'committed', CURRENT_TIMESTAMP(3))
         ON CONFLICT DO NOTHING`,
        [fulfillmentId, input.tenantId, acquisition.acquisition_id],
      );
      const [fulfillments] = await this.connection.execute<
        (RowDataPacket & { fulfillment_id: string })[]
      >(
        `SELECT fulfillment_id FROM entitlement_fulfillment WHERE tenant_id = $1 AND acquisition_id = $2 FOR UPDATE`,
        [input.tenantId, acquisition.acquisition_id],
      );
      if (!fulfillments[0]) throw new Error("billing.fulfillment_not_found");

      const grantId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_credit_grant
          (credit_grant_id, tenant_id, credit_account_id, source_kind, source_ref, program_key,
           original_micros, remaining_micros, effective_at, expires_at)
         VALUES ($1, $2, $3, 'subscription_period', $4, $5, $6, $7, CURRENT_TIMESTAMP(3), $8)
         ON CONFLICT DO NOTHING`,
        [
          grantId,
          input.tenantId,
          input.accountId,
          input.periodId,
          input.programKey,
          input.amountMicros,
          input.amountMicros,
          input.expiresAt,
        ],
      );
      const [grants] = await this.connection.execute<
        (RowDataPacket & {
          credit_grant_id: string;
          original_micros: number | string;
        })[]
      >(
        `SELECT credit_grant_id, original_micros, expires_at FROM entitlement_credit_grant
          WHERE tenant_id = $1 AND source_kind = 'subscription_period' AND source_ref = $2 AND program_key = $3 FOR UPDATE`,
        [input.tenantId, input.periodId, input.programKey],
      );
      const grant = grants[0] as
        | (RowDataPacket & {
            credit_grant_id: string;
            original_micros: number | string;
            expires_at: Date | string | null;
          })
        | undefined;
      if (
        !grant ||
        String(grant.original_micros) !== String(input.amountMicros) ||
        grant.expires_at === null ||
        new Date(grant.expires_at).getTime() !== input.expiresAt.getTime()
      )
        throw new Error("billing.idempotency_conflict");

      const [priorJournals] = await this.connection.execute<
        (RowDataPacket & { journal_id: string })[]
      >(
        `SELECT journal_id FROM entitlement_credit_journal
          WHERE tenant_id = $1 AND source_kind = 'subscription_period' AND source_ref = $2 AND entry_kind = 'grant' FOR UPDATE`,
        [input.tenantId, input.periodId],
      );
      if (priorJournals[0]) {
        await this.connection.commit();
        return {
          grantId: grant.credit_grant_id,
          journalId: priorJournals[0].journal_id,
        };
      }

      const [sequences] = await this.connection.execute<
        (RowDataPacket & { journal_seq: number | string })[]
      >(
        `SELECT COALESCE(MAX(journal_seq), 0) AS journal_seq FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2`,
        [input.tenantId, input.accountId],
      );
      const journalId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_credit_journal
          (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref)
         VALUES ($1, $2, $3, $4, 'grant', $5, 'subscription_period', $6)
         ON CONFLICT DO NOTHING`,
        [
          journalId,
          input.tenantId,
          input.accountId,
          (BigInt(String(sequences[0]?.journal_seq ?? 0)) + 1n).toString(),
          input.amountMicros,
          input.periodId,
        ],
      );
      const [journals] = await this.connection.execute<
        (RowDataPacket & { journal_id: string })[]
      >(
        `SELECT journal_id FROM entitlement_credit_journal
          WHERE tenant_id = $1 AND source_kind = 'subscription_period' AND source_ref = $2 AND entry_kind = 'grant' FOR UPDATE`,
        [input.tenantId, input.periodId],
      );
      const journal = journals[0];
      if (!journal) throw new Error("billing.journal_not_found");
      const [updated] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_account SET available_micros = available_micros + $1, generation = generation + 1 WHERE tenant_id = $2 AND credit_account_id = $3`,
        [input.amountMicros, input.tenantId, input.accountId],
      );
      if (updated.affectedRows !== 1)
        throw new Error("billing.credit_projection_drift");
      await this.connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'credit_grant', $3, 'SubscriptionCreditGranted', $4)
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          input.tenantId,
          grant.credit_grant_id,
          JSON.stringify({
            periodId: input.periodId,
            grantId: grant.credit_grant_id,
          }),
        ],
      );
      await this.connection.commit();
      return { grantId: grant.credit_grant_id, journalId: journal.journal_id };
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
