import type { SqlConnection, RowDataPacket } from "../../database.js";

export type ReconciliationReport = {
  readonly status: "ok" | "drift";
  readonly accountDrifts: readonly Record<string, unknown>[];
  readonly settlementDrifts: readonly Record<string, unknown>[];
  readonly reversalDrifts: readonly Record<string, unknown>[];
  readonly providerEventDrifts: readonly Record<string, unknown>[];
};

export class ReconciliationService {
  public constructor(private readonly connection: SqlConnection) {}

  public async run(tenantId?: string): Promise<ReconciliationReport> {
    const sitePredicate =
      tenantId === undefined ? "" : "WHERE a.tenant_id = $1";
    const siteArgs = tenantId === undefined ? [] : [tenantId];
    const [accountRows] = await this.connection.query<RowDataPacket[]>(
      `SELECT a.credit_account_id, a.available_micros, a.held_micros,
              COALESCE((SELECT SUM(g.remaining_micros) FROM entitlement_credit_grant g WHERE g.tenant_id = a.tenant_id AND g.credit_account_id = a.credit_account_id), 0) AS grant_remaining_micros,
              COALESCE((SELECT SUM(j.amount_micros) FROM entitlement_credit_journal j WHERE j.tenant_id = a.tenant_id AND j.credit_account_id = a.credit_account_id), 0) AS journal_micros,
              COALESCE((SELECT SUM(h.requested_micros) FROM entitlement_credit_hold h WHERE h.tenant_id = a.tenant_id AND h.credit_account_id = a.credit_account_id AND h.status = 'active'), 0) AS active_hold_micros,
              COALESCE((SELECT SUM(ha.held_micros - ha.captured_micros - ha.released_micros
                                    ) FROM entitlement_credit_hold_allocation ha
                         INNER JOIN entitlement_credit_hold h ON h.credit_hold_id = ha.credit_hold_id AND h.tenant_id = ha.tenant_id
                        WHERE ha.tenant_id = a.tenant_id AND h.credit_account_id = a.credit_account_id AND h.status = 'active'), 0) AS active_allocation_micros
         FROM entitlement_credit_account a ${sitePredicate}`,
      siteArgs,
    );
    const accountDrifts = accountRows
      .map((row) => ({
        accountId: String(row.credit_account_id),
        availableMicros: String(row.available_micros),
        balanceMicros: String(
          BigInt(String(row.available_micros)) +
            BigInt(String(row.held_micros)),
        ),
        grantRemainingMicros: String(row.grant_remaining_micros),
        journalMicros: String(row.journal_micros),
        heldMicros: String(row.held_micros),
        activeHoldMicros: String(row.active_hold_micros),
        activeAllocationMicros: String(row.active_allocation_micros),
      }))
      .filter(
        (row) =>
          row.balanceMicros !== row.grantRemainingMicros ||
          row.balanceMicros !== row.journalMicros ||
          row.heldMicros !== row.activeHoldMicros ||
          row.heldMicros !== row.activeAllocationMicros ||
          row.activeHoldMicros !== row.activeAllocationMicros,
      );

    const settlementPredicate =
      tenantId === undefined ? "" : "AND s.tenant_id = $1";
    const [settlementRows] = await this.connection.query<
      (RowDataPacket & {
        acquisition_id: string | null;
        fulfillment_id: string | null;
        fulfillment_status: string | null;
      })[]
    >(
      `SELECT s.settlement_id, s.status, a.acquisition_id, f.fulfillment_id, f.status AS fulfillment_status
         FROM payment_settlement s
         LEFT JOIN entitlement_acquisition a ON a.tenant_id = s.tenant_id AND a.source_kind = 'payment_settlement' AND a.source_ref = s.settlement_id
         LEFT JOIN entitlement_fulfillment f ON f.tenant_id = a.tenant_id AND f.acquisition_id = a.acquisition_id
        WHERE s.status = 'succeeded'
          AND (a.acquisition_id IS NULL OR f.fulfillment_id IS NULL OR f.status <> 'committed')
          ${settlementPredicate}`,
      tenantId === undefined ? [] : [tenantId],
    );
    const settlementDrifts = settlementRows.map((row) => ({
      settlementId: String(row.settlement_id),
      status: String(row.status),
      acquisitionId:
        row.acquisition_id === null ? null : String(row.acquisition_id),
      fulfillmentId:
        row.fulfillment_id === null ? null : String(row.fulfillment_id),
      fulfillmentStatus:
        row.fulfillment_status === null ? null : String(row.fulfillment_status),
    }));

    const reversalPredicate =
      tenantId === undefined ? "" : "AND r.tenant_id = $1";
    const [reversalRows] = await this.connection.query<
      (RowDataPacket & {
        fulfillment_reversal_id: string | null;
        fulfillment_reversal_status: string | null;
      })[]
    >(
      `SELECT r.reversal_id, r.status, fr.fulfillment_reversal_id, fr.status AS fulfillment_reversal_status
         FROM payment_reversal r
         LEFT JOIN entitlement_fulfillment_reversal fr ON fr.tenant_id = r.tenant_id AND fr.payment_reversal_id = r.reversal_id
        WHERE r.status = 'succeeded'
          AND (fr.fulfillment_reversal_id IS NULL OR fr.status <> 'committed')
          ${reversalPredicate}`,
      tenantId === undefined ? [] : [tenantId],
    );
    const reversalDrifts = reversalRows.map((row) => ({
      reversalId: String(row.reversal_id),
      status: String(row.status),
      fulfillmentReversalId:
        row.fulfillment_reversal_id === null
          ? null
          : String(row.fulfillment_reversal_id),
      fulfillmentReversalStatus:
        row.fulfillment_reversal_status === null
          ? null
          : String(row.fulfillment_reversal_status),
    }));

    const providerEventPredicate =
      tenantId === undefined ? "" : "AND tenant_id = $1";
    const [providerEventRows] = await this.connection.query<
      (RowDataPacket & { last_error: string | null })[]
    >(
      `SELECT provider_event_id, provider, external_event_id, event_type, processing_attempts, last_error
         FROM payment_provider_event
        WHERE processing_status = 'failed' ${providerEventPredicate}`,
      tenantId === undefined ? [] : [tenantId],
    );
    const providerEventDrifts = providerEventRows.map((row) => ({
      providerEventId: String(row.provider_event_id),
      provider: String(row.provider),
      externalEventId: String(row.external_event_id),
      eventType: String(row.event_type),
      processingAttempts: Number(row.processing_attempts),
      lastError: row.last_error === null ? null : String(row.last_error),
    }));

    return {
      status:
        accountDrifts.length === 0 &&
        settlementDrifts.length === 0 &&
        reversalDrifts.length === 0 &&
        providerEventDrifts.length === 0
          ? "ok"
          : "drift",
      accountDrifts,
      settlementDrifts,
      reversalDrifts,
      providerEventDrifts,
    };
  }
}
