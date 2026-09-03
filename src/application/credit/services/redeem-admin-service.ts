import type { TransactionPort } from '../../ports/transaction.js';
import type { RedeemAdminRepository } from '../ports/credit-repository.js';

export type CreateCampaignInput = { readonly tenantId: string; readonly campaignKey: string; readonly programKey: string; readonly creditMicros: number; readonly maxRedemptions: number; readonly startsAt?: Date; readonly endsAt?: Date | null; readonly idempotencyKey: string; readonly operatorId: string; readonly reason: string };
export type IssueCodesInput = { readonly tenantId: string; readonly campaignId: string; readonly count: number; readonly idempotencyKey: string; readonly operatorId: string; readonly reason: string };
export type CampaignResult = { readonly campaignId: string; readonly campaignKey: string };
export type IssueCodesResult = { readonly batchId: string; readonly campaignId: string; readonly codes: readonly string[] };

export class RedeemAdminService {
  public constructor(private readonly repository: RedeemAdminRepository, private readonly transaction: TransactionPort) {}
  public createCampaign(input: CreateCampaignInput): Promise<CampaignResult> { return this.transaction.withTransaction(() => this.repository.createCampaign(input)); }
  public issueCodes(input: IssueCodesInput): Promise<IssueCodesResult> { return this.transaction.withTransaction(() => this.repository.issueCodes(input)); }
  public disableCode(input: { readonly tenantId: string; readonly codeId: string; readonly operatorId: string; readonly reason: string; readonly idempotencyKey: string }): Promise<void> { return this.transaction.withTransaction(() => this.repository.disableCode(input)); }
}
