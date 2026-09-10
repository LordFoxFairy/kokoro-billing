import type { UsagePricingRepository } from "../ports/metering-repository.js";

export type UsageQuote = {
  readonly featureKey: string;
  readonly labelKey: string | null;
  readonly pricingRevisionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly amountMicros: number;
  readonly reservationMicros: number;
};
export type UsagePriceRate = {
  readonly featureKey: string;
  readonly labelKey: string | null;
  readonly modelBindingId: string | null;
  readonly pricingRevisionId: string;
  readonly inputMicrosPerMillion: string;
  readonly outputMicrosPerMillion: string;
  readonly reservationMicros: string;
};
export class UsagePricingService {
  public constructor(private readonly repository: UsagePricingRepository) {}
  public listActive(tenantId: string): Promise<UsagePriceRate[]> {
    return this.repository.listActive(tenantId);
  }
  public quote(input: {
    tenantId: string;
    featureKey: string;
    labelKey: string | null;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<UsageQuote> {
    return this.repository.quote(input);
  }
  public quoteForHold(input: {
    tenantId: string;
    holdId: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<UsageQuote> {
    return this.repository.quoteForHold(input);
  }
}
