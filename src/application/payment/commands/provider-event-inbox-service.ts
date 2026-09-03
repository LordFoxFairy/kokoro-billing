import type { TransactionPort } from '../../ports/transaction.js';
import type { ProviderEventInboxRepository } from '../ports/payment-repository.js';

export type ProviderEventInput = { readonly tenantId: string; readonly provider: string; readonly providerAccountRef?: string | null; readonly externalEventId: string; readonly eventType: string; readonly rawPayload: unknown; readonly signatureValid: boolean };
export type ProviderEventFact = { readonly providerEventId: string; readonly processingStatus: 'received' | 'processed' | 'ignored' | 'failed' };
export class ProviderEventInboxService {
  public constructor(private readonly repository: ProviderEventInboxRepository, private readonly transaction: TransactionPort) {}
  public accept(input: ProviderEventInput): Promise<ProviderEventFact> { return this.transaction.withTransaction(() => this.repository.accept(input)); }
}
