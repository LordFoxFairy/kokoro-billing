import type { TransactionPort } from '../../ports/transaction.js';
import type { UsagePricingAdminRepository } from '../ports/metering-repository.js';

export type UsagePriceRateInput = { readonly featureKey: string; readonly labelKey?: string | null; readonly modelBindingId?: string | null; readonly inputMicrosPerMillion: number; readonly outputMicrosPerMillion: number; readonly cachedMicrosPerMillion?: number; readonly reservationMicros: number };
export type PublishUsagePricingInput = { readonly tenantId: string; readonly operatorId: string; readonly effectiveFrom: Date; readonly rates: readonly UsagePriceRateInput[]; readonly reason: string; readonly idempotencyKey: string };
export type PublishedUsagePricing = { readonly pricingRevisionId: string; readonly revision: number; readonly effectiveFrom: string; readonly rates: readonly UsagePriceRateInput[] };
export class UsagePricingAdminService {
  public constructor(private readonly repository: UsagePricingAdminRepository, private readonly transaction: TransactionPort) {}
  public publish(input: PublishUsagePricingInput): Promise<PublishedUsagePricing> { return this.transaction.withTransaction(() => this.repository.publish(input)); }
}
