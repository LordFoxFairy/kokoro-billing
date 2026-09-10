export interface CreditAccountRepository {
  ensureForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<{ readonly accountId: string }>;
  getForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<Record<string, unknown> | null>;
  summaryForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<{
    balanceMicros: string;
    heldMicros: string;
    quotaMicros: string | null;
    quotaPeriod: string | null;
  }>;
  ledgerForSubject(
    tenantId: string,
    subjectId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ entries: unknown[]; nextCursor?: string }>;
  byModelForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<{ periodStart: string; items: unknown[] }>;
}

export interface AdminGrantRepository {
  grant(input: AdminGrantInput): Promise<AdminGrantResult>;
}

export interface GrantExpiryRepository {
  expireExpiredGrants(input?: {
    readonly tenantId?: string;
    readonly limit?: number;
  }): Promise<GrantExpiryResult>;
}

export interface RedeemAdminRepository {
  createCampaign(input: CreateCampaignInput): Promise<CampaignResult>;
  issueCodes(input: IssueCodesInput): Promise<IssueCodesResult>;
  disableCode(input: {
    readonly tenantId: string;
    readonly codeId: string;
    readonly operatorId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

export interface RedeemRepository {
  redeem(input: RedeemInput): Promise<RedeemResult>;
}

export interface SubscriptionGrantRepository {
  grant(input: SubscriptionGrantInput): Promise<CreditGrantResult>;
}
import type {
  AdminGrantInput,
  AdminGrantResult,
} from "../services/admin-grant-service.js";
import type { GrantExpiryResult } from "../services/grant-expiry-service.js";
import type {
  CampaignResult,
  CreateCampaignInput,
  IssueCodesInput,
  IssueCodesResult,
} from "../services/redeem-admin-service.js";
import type { RedeemInput, RedeemResult } from "../services/redeem-service.js";
import type {
  CreditGrantResult,
  SubscriptionGrantInput,
} from "../services/subscription-grant-service.js";
