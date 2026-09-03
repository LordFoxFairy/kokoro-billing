import type { TransactionPort } from '../../ports/transaction.js';
import type { CheckoutRepository } from '../ports/checkout-repository.js';

export type CreateCheckoutInput = { readonly tenantId: string; readonly subjectId: string; readonly idempotencyKey: string; readonly offerRevisionId: string; readonly amountMinor: number; readonly currency: string; readonly quoteSnapshot: unknown; readonly expiresAt: Date };
export type Checkout = { readonly checkoutId: string; readonly status: 'created' | 'pending_payment' | 'paid' | 'expired' | 'cancelled'; readonly amountMinor: number; readonly currency: string; readonly expiresAt: Date; readonly checkoutUrl?: string };

export class CheckoutService {
  public constructor(private readonly repository: CheckoutRepository, private readonly transaction: TransactionPort) {}
  public create(input: CreateCheckoutInput): Promise<Checkout> { return this.transaction.withTransaction(() => this.repository.create(input)); }
  public createHostedSession(tenantId: string, checkoutId: string): Promise<Checkout> { return this.transaction.withTransaction(() => this.repository.createHostedSession(tenantId, checkoutId)); }
}
