import type { AdminStatsRepository } from "../ports/reconciliation-repository.js";

export type AdminStats = {
  checkouts: Record<string, string>;
  settlements: {
    byStatus: Record<string, string>;
    succeededAmountMinorByCurrency: Record<string, string>;
  };
  reversals: {
    byStatus: Record<string, string>;
    succeededAmountMinorByCurrency: Record<string, string>;
  };
  providerEvents: Record<string, string>;
  credit: { accountCount: string; grantCount: string; remainingMicros: string };
};
export class AdminStatsService {
  public constructor(private readonly repository: AdminStatsRepository) {}
  public get(tenantId: string): Promise<AdminStats> {
    return this.repository.get(tenantId);
  }
  public listCreditOperations(
    tenantId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.repository.listCreditOperations(tenantId);
  }
  public listPaymentOperations(
    tenantId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.repository.listPaymentOperations(tenantId);
  }
}
