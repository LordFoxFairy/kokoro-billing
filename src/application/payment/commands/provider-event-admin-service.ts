import type { TransactionPort } from '../../ports/transaction.js';
import type { ProviderEventAdminRepository } from '../ports/payment-repository.js';

export type ProviderEventRetryInput = { readonly tenantId: string; readonly providerEventId: string; readonly operatorId: string; readonly reason: string; readonly idempotencyKey: string };
export type ProviderEventRetryResult = { readonly providerEventId: string; readonly processingStatus: 'received' | 'processed' | 'ignored' | 'failed' };
export type ProviderEventListItem = { readonly providerEventId: string; readonly provider: string; readonly externalEventId: string; readonly eventType: string; readonly processingStatus: ProviderEventRetryResult['processingStatus']; readonly processingAttempts: number; readonly lastError: string | null; readonly receivedAt: string; readonly processedAt: string | null };
export class ProviderEventAdminService {
  public constructor(private readonly repository: ProviderEventAdminRepository, private readonly transaction: TransactionPort) {}
  public list(input: { readonly tenantId: string; readonly status?: ProviderEventRetryResult['processingStatus']; readonly limit?: number; readonly cursor?: string }): Promise<{ readonly items: readonly ProviderEventListItem[]; readonly nextCursor?: string }> { return this.repository.list(input); }
  public retry(input: ProviderEventRetryInput): Promise<ProviderEventRetryResult> { return this.transaction.withTransaction(() => this.repository.retry(input)); }
}
