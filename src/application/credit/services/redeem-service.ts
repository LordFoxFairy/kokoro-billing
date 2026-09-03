import type { TransactionPort } from '../../ports/transaction.js';
import type { RedeemRepository } from '../ports/credit-repository.js';

export type RedeemInput = { readonly tenantId: string; readonly subjectId: string; readonly code: string; readonly idempotencyKey: string };
export type RedeemResult = { readonly redemptionId: string; readonly grantId: string; readonly amountMicros: string; readonly programKey: string };
export class RedeemService {
  public constructor(private readonly repository: RedeemRepository, private readonly transaction: TransactionPort) {}
  public redeem(input: RedeemInput): Promise<RedeemResult> { return this.transaction.withTransaction(() => this.repository.redeem(input)); }
}
