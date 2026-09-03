import type { TransactionPort } from '../../ports/transaction.js';
import type { BillingReversalRepository } from '../ports/refund-repository.js';

export type RecordReversalInput = { readonly tenantId: string; readonly settlementId: string; readonly provider?: string; readonly externalReversalRef: string; readonly amountMinor: number; readonly reason: string; readonly idempotencyKey: string; readonly operatorId?: string };
export type ReverseCreditsInput = { readonly tenantId: string; readonly reversalId: string; readonly settlementId: string; readonly accountId: string; readonly amountMicros?: number };
export type ReversalResult = { readonly fulfillmentReversalId: string; readonly journalId: string };
export class BillingReversalService {
  public constructor(private readonly repository: BillingReversalRepository, private readonly transaction: TransactionPort) {}
  public recordReversal(input: RecordReversalInput): Promise<string> { return this.transaction.withTransaction(() => this.repository.recordReversal(input)); }
  public reverseCredits(input: ReverseCreditsInput): Promise<ReversalResult> { return this.transaction.withTransaction(() => this.repository.reverseCredits(input)); }
}
