import type { TransactionPort } from '../../ports/transaction.js';
import type { UsageSettlementRepository } from '../ports/metering-repository.js';

export type UsageEventInput = { readonly usageEventId: string; readonly tenantId: string; readonly subjectId: string; readonly sourceEventId: string; readonly featureKey: string; readonly quantityMicros: number; readonly dimensions?: Record<string, unknown> };
export type AuthorizeUsageInput = { readonly tenantId: string; readonly accountId: string; readonly idempotencyKey: string; readonly requestedMicros: number; readonly featureKey: string; readonly labelKey?: string | null; readonly modelBindingId?: string | null; readonly pricingRevisionId?: string | null; readonly ttlSeconds?: number };
export type UsageHold = { readonly holdId: string; readonly allocations: readonly { readonly grantId: string; readonly amountMicros: number }[] };
export type SettleUsageInput = { readonly tenantId: string; readonly holdId: string; readonly usageEventId: string; readonly idempotencyKey: string; readonly actualMicros: number };
export type UsageSettlementResult = { readonly settlementId: string; readonly capturedMicros: number; readonly releasedMicros: number };
export type UsageReleaseResult = { readonly holdId: string; readonly releasedMicros: number };
export type ExpireUsageHoldsInput = { readonly tenantId: string; readonly batchId: string; readonly idempotencyKey: string; readonly limit?: number };
export type UsageExpiryResult = { readonly batchId: string; readonly expiredHoldIds: readonly string[] };
export class UsageSettlementService {
  public constructor(private readonly repository: UsageSettlementRepository, private readonly transaction: TransactionPort) {}
  public recordUsageEvent(input: UsageEventInput): Promise<void> { return this.transaction.withTransaction(() => this.repository.recordUsageEvent(input)); }
  public ensureUsageEventForHold(input: { tenantId: string; holdId: string; sourceEventId: string }): Promise<string> { return this.transaction.withTransaction(() => this.repository.ensureUsageEventForHold(input)); }
  public authorizeUsage(input: AuthorizeUsageInput): Promise<UsageHold> { return this.transaction.withTransaction(() => this.repository.authorizeUsage(input)); }
  public settleUsage(input: SettleUsageInput): Promise<UsageSettlementResult> { return this.transaction.withTransaction(() => this.repository.settleUsage(input)); }
  public releaseUsage(input: { readonly tenantId: string; readonly holdId: string; readonly idempotencyKey: string }): Promise<UsageReleaseResult> { return this.transaction.withTransaction(() => this.repository.releaseUsage(input)); }
  public expireExpiredHolds(input: ExpireUsageHoldsInput): Promise<UsageExpiryResult> { return this.transaction.withTransaction(() => this.repository.expireExpiredHolds(input)); }
}
