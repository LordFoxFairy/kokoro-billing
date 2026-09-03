import type { FulfillmentResult, FulfillSettlementInput, RecordSettlementInput } from '../commands/billing-settlement-service.js';
import type { ProviderEventListItem, ProviderEventRetryInput, ProviderEventRetryResult } from '../commands/provider-event-admin-service.js';
import type { ProviderEventFact, ProviderEventInput } from '../commands/provider-event-inbox-service.js';

export interface BillingSettlementRepository {
  recordSettlement(input: RecordSettlementInput): Promise<void>;
  fulfillSettlement(input: FulfillSettlementInput): Promise<FulfillmentResult>;
}

export interface ProviderEventAdminRepository {
  list(input: { readonly tenantId: string; readonly status?: ProviderEventRetryResult['processingStatus']; readonly limit?: number; readonly cursor?: string }): Promise<{ readonly items: readonly ProviderEventListItem[]; readonly nextCursor?: string }>;
  retry(input: ProviderEventRetryInput): Promise<ProviderEventRetryResult>;
}

export interface ProviderEventInboxRepository {
  accept(input: ProviderEventInput): Promise<ProviderEventFact>;
}

export interface ProviderEventProcessorRepository {
  process(providerEventId: string): Promise<void>;
}

export interface ProviderAccountRepository {
  resolveTenantId(provider: string, externalAccountRef: string): Promise<string | null>;
}
