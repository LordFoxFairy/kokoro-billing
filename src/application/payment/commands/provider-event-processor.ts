import type { TransactionPort } from '../../ports/transaction.js';
import type { ProviderEventProcessorRepository } from '../ports/payment-repository.js';

export class ProviderEventProcessor {
  public constructor(private readonly repository: ProviderEventProcessorRepository, private readonly transaction: TransactionPort) {}
  public process(providerEventId: string): Promise<void> { return this.transaction.withTransaction(() => this.repository.process(providerEventId)); }
}
