import { randomUUID } from "node:crypto";
import type {
  SqlConnection,
  ResultSetHeader,
  RowDataPacket,
} from "../../database.js";
import { readSafeInteger } from "../../../../application/ports/safe-integer.js";

export type GrantExpiryResult = { readonly expiredGrantIds: readonly string[] };

/** Reclaims expired, unreserved grant balance in durable PostgreSQL transactions. */
export class GrantExpiryService {
  public constructor(private readonly connection: SqlConnection) {}

  public async expireExpiredGrants(
    input: { readonly tenantId?: string; readonly limit?: number } = {},
  ): Promise<GrantExpiryResult> {
    const requestedLimit = input.limit ?? 100;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0)
      throw new RangeError("limit must be a positive safe integer");
    const limit = Math.min(requestedLimit, 500);
    const sitePredicate =
      input.tenantId === undefined ? "" : "AND g.tenant_id = $1";
    const siteArgs =
      input.tenantId === undefined ? [limit] : [input.tenantId, limit];
    const [grants] = await this.connection.query<RowDataPacket[]>(
      `SELECT g.credit_grant_id, g.tenant_id
         FROM entitlement_credit_grant g
        WHERE g.status = 'active' AND g.remaining_micros > 0
          AND g.expires_at IS NOT NULL AND g.expires_at <= CURRENT_TIMESTAMP(3)
          AND NOT EXISTS (
            SELECT 1
              FROM entitlement_credit_hold_allocation ha
              INNER JOIN entitlement_credit_hold h ON h.credit_hold_id = ha.credit_hold_id AND h.tenant_id = ha.tenant_id
             WHERE ha.tenant_id = g.tenant_id AND ha.credit_grant_id = g.credit_grant_id AND h.status = 'active'
               AND ha.held_micros > ha.captured_micros + ha.released_micros
          )
          ${sitePredicate}
        ORDER BY g.expires_at, g.credit_grant_id
        LIMIT ${input.tenantId === undefined ? "$1" : "$2"}`,
      siteArgs,
    );
    const expiredGrantIds: string[] = [];
    for (const row of grants) {
      const grantId = String(row.credit_grant_id);
      await this.connection.beginTransaction();
      try {
        const [lockedRows] = await this.connection.execute<RowDataPacket[]>(
          `SELECT credit_grant_id, tenant_id, credit_account_id, remaining_micros, status, expires_at
             FROM entitlement_credit_grant
            WHERE tenant_id = $1 AND credit_grant_id = $2 AND status = 'active'
              AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP(3)
            FOR UPDATE`,
          [String(row.tenant_id), grantId],
        );
        const grant = lockedRows[0] as
          | {
              credit_grant_id: string;
              tenant_id: string;
              credit_account_id: string;
              remaining_micros: string | number;
              status: string;
            }
          | undefined;
        if (!grant) {
          await this.connection.rollback();
          continue;
        }
        const [activeAllocations] = await this.connection.execute<
          RowDataPacket[]
        >(
          `SELECT 1
             FROM entitlement_credit_hold_allocation ha
             INNER JOIN entitlement_credit_hold h ON h.credit_hold_id = ha.credit_hold_id AND h.tenant_id = ha.tenant_id
            WHERE ha.tenant_id = $1 AND ha.credit_grant_id = $2 AND h.status = 'active'
              AND ha.held_micros > ha.captured_micros + ha.released_micros
            LIMIT 1`,
          [grant.tenant_id, grantId],
        );
        if (activeAllocations[0]) {
          await this.connection.rollback();
          continue;
        }
        const remaining = readSafeInteger(
          grant.remaining_micros,
          "grant_remaining_micros",
        );
        if (remaining > 0) {
          const [sequences] = await this.connection.execute<RowDataPacket[]>(
            `SELECT COALESCE(MAX(journal_seq), 0) AS journal_seq
               FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2`,
            [grant.tenant_id, grant.credit_account_id],
          );
          const journalSeq = (
            BigInt(
              String(
                (sequences[0] as { journal_seq: number | string }).journal_seq,
              ),
            ) + 1n
          ).toString();
          await this.connection.execute(
            `INSERT INTO entitlement_credit_journal
              (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref)
             VALUES ($1, $2, $3, $4, 'expiry', $5, 'grant_expiry', $6)`,
            [
              randomUUID(),
              grant.tenant_id,
              grant.credit_account_id,
              journalSeq,
              -remaining,
              grantId,
            ],
          );
          const [accountUpdate] =
            await this.connection.execute<ResultSetHeader>(
              `UPDATE entitlement_credit_account
                SET available_micros = available_micros - $1, generation = generation + 1
              WHERE credit_account_id = $2 AND tenant_id = $3 AND available_micros >= $4`,
              [remaining, grant.credit_account_id, grant.tenant_id, remaining],
            );
          if (accountUpdate.affectedRows !== 1)
            throw new Error("billing.credit_projection_drift");
        }
        await this.connection.execute(
          `UPDATE entitlement_credit_grant SET remaining_micros = 0, status = 'expired'
            WHERE credit_grant_id = $1 AND tenant_id = $2 AND status = 'active'`,
          [grantId, grant.tenant_id],
        );
        await this.connection.execute(
          `INSERT INTO entitlement_outbox
            (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
           VALUES ($1, $2, 'credit_grant', $3, 'CreditGrantExpired', $4)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            grant.tenant_id,
            grantId,
            JSON.stringify({ grantId, reason: "expires_at" }),
          ],
        );
        await this.connection.commit();
        expiredGrantIds.push(grantId);
      } catch (error) {
        await this.connection.rollback();
        throw error;
      }
    }
    return { expiredGrantIds };
  }
}
