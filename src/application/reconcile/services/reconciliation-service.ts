import type { ReconciliationRepository } from "../ports/reconciliation-repository.js";

export type ReconciliationReport = {
  readonly status: "ok" | "drift";
  readonly accountDrifts: readonly Record<string, unknown>[];
  readonly settlementDrifts: readonly Record<string, unknown>[];
  readonly reversalDrifts: readonly Record<string, unknown>[];
  readonly providerEventDrifts: readonly Record<string, unknown>[];
};
export class ReconciliationService {
  public constructor(private readonly repository: ReconciliationRepository) {}
  public run(tenantId?: string): Promise<ReconciliationReport> {
    return this.repository.run(tenantId);
  }
}
