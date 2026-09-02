import type { Connection, RowDataPacket } from '../../application/ports.js';

export type SubscriptionView = {
  readonly subscriptionId: string;
  readonly status: string;
  readonly planKey: string;
  readonly periodStart: string;
  readonly periodEnd: string;
};

/** Read-only subscription projection; provider facts remain Payment-owned. */
export class SubscriptionQueryService {
  public constructor(private readonly connection: Connection) {}

  public async listForSubject(tenantId: string, subjectId: string): Promise<readonly SubscriptionView[]> {
    const [rows] = await this.connection.execute<(RowDataPacket & { term_id: string; status: string; program_key: string; period_start: Date | string; period_end: Date | string })[]>(
      `SELECT term_id, status, program_key, period_start, period_end
         FROM entitlement_subscription_term
        WHERE tenant_id = $1 AND subject_id = $2
        ORDER BY period_start DESC, term_id DESC`, [tenantId, subjectId],
    );
    return rows.map((row) => ({ subscriptionId: row.term_id, status: row.status, planKey: row.program_key, periodStart: new Date(row.period_start).toISOString(), periodEnd: new Date(row.period_end).toISOString() }));
  }
}
