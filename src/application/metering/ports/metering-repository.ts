import type {
  AcceptedReceipt,
  BillingAdmissionResult,
  CreateBillingAdmissionInput,
  ExecutionEventInput,
} from '../services/billing-admission-service.js';
import type { PublishedUsagePricing, PublishUsagePricingInput } from '../services/usage-pricing-admin-service.js';
import type { UsagePriceRate, UsageQuote } from '../services/usage-pricing-service.js';
import type {
  AuthorizeUsageInput,
  ExpireUsageHoldsInput,
  SettleUsageInput,
  UsageEventInput,
  UsageExpiryResult,
  UsageHold,
  UsageReleaseResult,
  UsageSettlementResult,
} from '../services/usage-settlement-service.js';

export interface BillingAdmissionRepository {
  create(input: CreateBillingAdmissionInput): Promise<BillingAdmissionResult>;
  capture(tenantId: string, admissionId: string, receipt: AcceptedReceipt, idempotencyKey: string): Promise<BillingAdmissionResult>;
  release(tenantId: string, admissionId: string, reason: string, idempotencyKey: string): Promise<BillingAdmissionResult>;
  recordExecutionEvent(input: ExecutionEventInput): Promise<{ readonly eventId: string; readonly status: 'received' | 'processed' }>;
  processExecutionEvent(tenantId: string, eventId: string): Promise<void>;
}

export interface UsagePricingAdminRepository {
  publish(input: PublishUsagePricingInput): Promise<PublishedUsagePricing>;
}

export interface UsagePricingRepository {
  listActive(tenantId: string): Promise<UsagePriceRate[]>;
  quote(input: { tenantId: string; featureKey: string; labelKey: string | null; inputTokens?: number; outputTokens?: number }): Promise<UsageQuote>;
  quoteForHold(input: { tenantId: string; holdId: string; inputTokens?: number; outputTokens?: number }): Promise<UsageQuote>;
}

export interface UsageSettlementRepository {
  recordUsageEvent(input: UsageEventInput): Promise<void>;
  ensureUsageEventForHold(input: { tenantId: string; holdId: string; sourceEventId: string }): Promise<string>;
  authorizeUsage(input: AuthorizeUsageInput): Promise<UsageHold>;
  settleUsage(input: SettleUsageInput): Promise<UsageSettlementResult>;
  releaseUsage(input: { readonly tenantId: string; readonly holdId: string; readonly idempotencyKey: string }): Promise<UsageReleaseResult>;
  expireExpiredHolds(input: ExpireUsageHoldsInput): Promise<UsageExpiryResult>;
}
