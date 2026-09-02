import { randomUUID } from 'node:crypto';
import type { Connection, RowDataPacket } from '../../../src/infrastructure/postgres/connection.js';

export class CreditAccountQueryService {
  public constructor(private readonly connection: Connection) {}

  public async ensureForSubject(tenantId: string, subjectId: string): Promise<{ readonly accountId: string }> {
    const accountId = randomUUID();
    await this.connection.execute(
      `INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [accountId, tenantId, subjectId],
    );
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT credit_account_id FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2`,
      [tenantId, subjectId],
    );
    const row = rows[0] as { credit_account_id: string } | undefined;
    if (!row) throw new Error('billing.credit_account_not_found');
    return { accountId: row.credit_account_id };
  }

  public async getForSubject(tenantId: string, subjectId: string): Promise<Record<string, unknown> | null> {
    const [accounts] = await this.connection.execute<RowDataPacket[]>(
      `SELECT credit_account_id, status, available_micros, held_micros, generation, updated_at
         FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2`,
      [tenantId, subjectId],
    );
    const account = accounts[0] as { credit_account_id: string; status: string; available_micros: number; held_micros: number; generation: number; updated_at: Date } | undefined;
    if (!account) return null;
    const [grants] = await this.connection.execute<RowDataPacket[]>(
      `SELECT credit_grant_id, program_key, original_micros, remaining_micros, effective_at, expires_at, burn_priority, status
         FROM entitlement_credit_grant WHERE tenant_id = $1 AND credit_account_id = $2 ORDER BY expires_at IS NULL, expires_at, burn_priority, issued_at, credit_grant_id`,
      [tenantId, account.credit_account_id],
    );
    return {
      accountId: account.credit_account_id,
      status: account.status,
      availableMicros: String(account.available_micros),
      heldMicros: String(account.held_micros),
      generation: String(account.generation),
      grants: grants.map((grant) => ({
        creditGrantId: String(grant.credit_grant_id),
        programKey: String(grant.program_key),
        originalMicros: String(grant.original_micros),
        remainingMicros: String(grant.remaining_micros),
        effectiveAt: grant.effective_at,
        expiresAt: grant.expires_at,
        burnPriority: Number(grant.burn_priority),
        status: String(grant.status),
      })),
      updatedAt: account.updated_at,
    };
  }

  public async summaryForSubject(tenantId: string, subjectId: string): Promise<{ balanceMicros: string; heldMicros: string; quotaMicros: string | null; quotaPeriod: string | null }> {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT available_micros, held_micros, quota_micros, quota_period FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2`,
      [tenantId, subjectId],
    );
    const row = rows[0] as { available_micros: string | number; held_micros: string | number; quota_micros: string | number | null; quota_period: string | null } | undefined;
    return { balanceMicros: String(row?.available_micros ?? 0), heldMicros: String(row?.held_micros ?? 0), quotaMicros: row?.quota_micros === null || row?.quota_micros === undefined ? null : String(row.quota_micros), quotaPeriod: row?.quota_period ?? null };
  }

  public async ledgerForSubject(tenantId: string, subjectId: string, limit: number, cursor?: string): Promise<{ entries: unknown[]; nextCursor?: string }> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const decodedCursor = cursor === undefined ? undefined : decodeLedgerCursor(cursor);
    const cursorPredicate = decodedCursor === undefined ? '' : 'WHERE ledger.created_at < ? OR (ledger.created_at = ? AND (ledger.journal_seq < ? OR (ledger.journal_seq = ? AND ledger.journal_id < ?)))';
    const cursorArgs = decodedCursor === undefined ? [] : [new Date(decodedCursor.createdAt), new Date(decodedCursor.createdAt), decodedCursor.journalSeq, decodedCursor.journalSeq, decodedCursor.journalId];
    const [rows] = await this.connection.query<RowDataPacket[]>(
      `SELECT ledger.journal_id, ledger.journal_seq, ledger.amount_micros, ledger.source_kind, ledger.created_at, ledger.balance_after_micros
         FROM (
           SELECT j.journal_id, j.journal_seq, j.amount_micros, j.source_kind, j.created_at,
                  SUM(j.amount_micros) OVER (PARTITION BY j.credit_account_id ORDER BY j.created_at, j.journal_seq, j.journal_id ROWS UNBOUNDED PRECEDING) AS balance_after_micros
             FROM entitlement_credit_journal j
             INNER JOIN entitlement_credit_account a ON a.credit_account_id = j.credit_account_id
            WHERE a.tenant_id = $1 AND a.subject_id = $2
         ) AS ledger
         ${cursorPredicate}
        ORDER BY ledger.created_at DESC, ledger.journal_seq DESC, ledger.journal_id DESC LIMIT $3`,
      [tenantId, subjectId, ...cursorArgs, safeLimit],
    );
    const entries = rows.map((row) => ({ entryId: String(row.journal_id), deltaMicros: String(row.amount_micros), balanceAfterMicros: String(row.balance_after_micros), reason: String(row.source_kind), createdAt: new Date(row.created_at as string | Date).getTime(), runId: null }));
    if (rows.length < safeLimit) return { entries };
    const last = rows[rows.length - 1];
    if (!last) return { entries };
    return { entries, nextCursor: encodeLedgerCursor({ createdAt: toCursorDate(last.created_at), journalSeq: String(last.journal_seq), journalId: String(last.journal_id) }) };
  }

  public async byModelForSubject(tenantId: string, subjectId: string): Promise<{ periodStart: string; items: unknown[] }> {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT h.model_binding_id, COALESCE(h.label_key, h.feature_key) AS model_name,
              COALESCE(SUM(CASE WHEN j.amount_micros < 0 THEN -j.amount_micros ELSE 0 END), 0) AS spent_micros,
              COUNT(DISTINCT CASE WHEN j.amount_micros < 0 THEN j.source_ref END) AS run_count
         FROM entitlement_credit_journal j
         INNER JOIN entitlement_credit_account a ON a.credit_account_id = j.credit_account_id
         LEFT JOIN entitlement_credit_hold h ON h.tenant_id = a.tenant_id AND h.credit_hold_id = j.source_ref AND j.source_kind = 'usage_settlement'
        WHERE a.tenant_id = $1 AND a.subject_id = $2
        GROUP BY h.model_binding_id, model_name ORDER BY spent_micros DESC, model_name`,
      [tenantId, subjectId],
    );
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    return { periodStart, items: rows.map((row) => ({ modelBindingId: row.model_binding_id === null ? null : String(row.model_binding_id), modelName: String(row.model_name ?? '未归属'), spentMicros: String(row.spent_micros), runCount: Number(row.run_count) })) };
  }
}

type LedgerCursor = { readonly createdAt: string; readonly journalSeq: string; readonly journalId: string };

function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function toCursorDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('billing.invalid_cursor');
  return date.toISOString();
}

function decodeLedgerCursor(value: string): LedgerCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (typeof cursor.createdAt !== 'string' || typeof cursor.journalSeq !== 'string' || typeof cursor.journalId !== 'string' || cursor.createdAt.length === 0 || cursor.journalSeq.length === 0 || cursor.journalId.length === 0 || Number.isNaN(Date.parse(cursor.createdAt))) throw new Error();
    return { createdAt: cursor.createdAt, journalSeq: cursor.journalSeq, journalId: cursor.journalId };
  } catch {
    throw new Error('billing.invalid_cursor');
  }
}
