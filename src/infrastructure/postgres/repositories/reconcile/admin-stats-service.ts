import type { SqlConnection, RowDataPacket } from "../../database.js";

type CountRow = RowDataPacket & { status: string; count: string | number };
type CurrencyTotalRow = RowDataPacket & {
  currency: string;
  amount_minor: string | number;
};

const countByStatus = async (
  connection: SqlConnection,
  table: string,
  statusColumn: string,
  tenantId: string,
): Promise<Record<string, string>> => {
  const [rows] = await connection.execute<CountRow[]>(
    `SELECT ${statusColumn} AS status, COUNT(*) AS count FROM ${table} WHERE tenant_id = $1 GROUP BY ${statusColumn}`,
    [tenantId],
  );
  return Object.fromEntries(rows.map((row) => [row.status, String(row.count)]));
};

const amountByCurrency = async (
  connection: SqlConnection,
  table: "payment_settlement" | "payment_reversal",
  tenantId: string,
): Promise<Record<string, string>> => {
  const query =
    table === "payment_settlement"
      ? "SELECT currency, COALESCE(SUM(amount_minor), 0) AS amount_minor FROM payment_settlement WHERE tenant_id = $1 AND status = 'succeeded' GROUP BY currency"
      : "SELECT s.currency, COALESCE(SUM(r.amount_minor), 0) AS amount_minor FROM payment_reversal r JOIN payment_settlement s ON s.tenant_id = r.tenant_id AND s.settlement_id = r.settlement_id WHERE r.tenant_id = $1 AND r.status = 'succeeded' GROUP BY s.currency";
  const [rows] = await connection.execute<CurrencyTotalRow[]>(query, [
    tenantId,
  ]);
  return Object.fromEntries(
    rows.map((row) => [row.currency, String(row.amount_minor)]),
  );
};

export class AdminStatsService {
  public constructor(private readonly connection: SqlConnection) {}

  public async get(tenantId: string) {
    const [
      checkout,
      settlement,
      reversal,
      providerEvents,
      creditAccounts,
      creditGrants,
      creditRemaining,
      settlementAmounts,
      reversalAmounts,
    ] = await Promise.all([
      countByStatus(this.connection, "payment_checkout", "status", tenantId),
      countByStatus(this.connection, "payment_settlement", "status", tenantId),
      countByStatus(this.connection, "payment_reversal", "status", tenantId),
      countByStatus(
        this.connection,
        "payment_provider_event",
        "processing_status",
        tenantId,
      ),
      this.connection.execute<Record<string, string>[]>(
        "SELECT COUNT(*) AS count FROM entitlement_credit_account WHERE tenant_id = $1",
        [tenantId],
      ),
      this.connection.execute<Record<string, string>[]>(
        "SELECT COUNT(*) AS count FROM entitlement_credit_grant WHERE tenant_id = $1",
        [tenantId],
      ),
      this.connection.execute<Record<string, string>[]>(
        "SELECT COALESCE(SUM(remaining_micros), 0) AS amount FROM entitlement_credit_grant WHERE tenant_id = $1",
        [tenantId],
      ),
      amountByCurrency(this.connection, "payment_settlement", tenantId),
      amountByCurrency(this.connection, "payment_reversal", tenantId),
    ]);
    const scalar = (
      result: [Record<string, string>[], unknown],
      key: string,
    ): string => result[0][0]?.[key] ?? "0";
    return {
      checkouts: checkout,
      settlements: {
        byStatus: settlement,
        succeededAmountMinorByCurrency: settlementAmounts,
      },
      reversals: {
        byStatus: reversal,
        succeededAmountMinorByCurrency: reversalAmounts,
      },
      providerEvents: providerEvents,
      credit: {
        accountCount: scalar(creditAccounts, "count"),
        grantCount: scalar(creditGrants, "count"),
        remainingMicros: scalar(creditRemaining, "amount"),
      },
    };
  }

  public async listCreditOperations(
    tenantId: string,
  ): Promise<Record<string, unknown>[]> {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT credit_grant_id AS operation_id, tenant_id, 'grant' AS operation_type,
              credit_account_id, source_kind, source_ref, program_key,
              original_micros, remaining_micros, status, issued_at AS created_at
         FROM entitlement_credit_grant WHERE tenant_id = $1
        ORDER BY issued_at DESC, credit_grant_id DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => ({
      operationId: String(row.operation_id),
      tenantId: String(row.tenant_id),
      operationType: String(row.operation_type),
      creditAccountId: String(row.credit_account_id),
      sourceKind: String(row.source_kind),
      sourceRef: String(row.source_ref),
      programKey: String(row.program_key),
      originalMicros: String(row.original_micros),
      remainingMicros: String(row.remaining_micros),
      status: String(row.status),
      createdAt: row.created_at,
    }));
  }

  public async listPaymentOperations(
    tenantId: string,
  ): Promise<Record<string, unknown>[]> {
    const [rows] = await this.connection.execute<
      (RowDataPacket & {
        subject_id: string | null;
        provider: string | null;
        external_ref: string | null;
        currency: string | null;
      })[]
    >(
      `SELECT operation_id, tenant_id, operation_type, subject_id, provider, external_ref,
              amount_minor, currency, status, created_at
         FROM (
           SELECT checkout_id AS operation_id, tenant_id, 'checkout' AS operation_type,
                  subject_id, NULL AS provider, NULL AS external_ref,
                  amount_minor, currency, status, created_at
             FROM payment_checkout WHERE tenant_id = $1
           UNION ALL
           SELECT settlement_id, tenant_id, 'settlement', NULL, provider, external_payment_ref,
                  amount_minor, currency, status, created_at
             FROM payment_settlement WHERE tenant_id = $2
           UNION ALL
           SELECT reversal_id, tenant_id, 'reversal', NULL, provider, external_reversal_ref,
                  amount_minor, NULL, status, created_at
             FROM payment_reversal WHERE tenant_id = $3
         ) operations
        ORDER BY created_at DESC, operation_id DESC LIMIT 100`,
      [tenantId, tenantId, tenantId],
    );
    return rows.map((row) => ({
      operationId: String(row.operation_id),
      tenantId: String(row.tenant_id),
      operationType: String(row.operation_type),
      subjectId: row.subject_id === null ? null : String(row.subject_id),
      provider: row.provider === null ? null : String(row.provider),
      externalRef: row.external_ref === null ? null : String(row.external_ref),
      amountMinor: String(row.amount_minor),
      currency: row.currency === null ? null : String(row.currency),
      status: String(row.status),
      createdAt: row.created_at,
    }));
  }
}
