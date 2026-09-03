import type { TransactionPort } from '../../ports/transaction.js';
import type { BillingSettlementRepository } from '../ports/payment-repository.js';

export type RecordSettlementInput = { readonly settlementId: string; readonly tenantId: string; readonly externalPaymentRef: string; readonly amountMinor: number; readonly currency: string; readonly provider?: string; readonly providerEventId?: string; readonly checkoutId?: string };
export type FulfillSettlementInput = { readonly settlementId: string; readonly tenantId: string; readonly accountId: string; readonly subjectId: string; readonly programKey: string; readonly grantMicros: number };
export type FulfillmentResult = { readonly fulfillmentId: string; readonly grantId: string; readonly journalId: string };
export class BillingSettlementService {
  public constructor(private readonly repository: BillingSettlementRepository, private readonly transaction: TransactionPort) {}
  public recordSettlement(input: RecordSettlementInput): Promise<void> { return this.transaction.withTransaction(() => this.repository.recordSettlement(input)); }
  public fulfillSettlement(input: FulfillSettlementInput): Promise<FulfillmentResult> { return this.transaction.withTransaction(() => this.repository.fulfillSettlement(input)); }
}
