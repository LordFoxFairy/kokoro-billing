import type { AdminStats } from "../queries/admin-stats-service.js";
import type { ReconciliationReport } from "../services/reconciliation-service.js";

export interface AdminStatsRepository {
  get(tenantId: string): Promise<AdminStats>;
  listCreditOperations(tenantId: string): Promise<Record<string, unknown>[]>;
  listPaymentOperations(tenantId: string): Promise<Record<string, unknown>[]>;
}

export interface ReconciliationRepository {
  run(tenantId?: string): Promise<ReconciliationReport>;
}
