import type { ProviderAccountRepository } from '../ports/payment-repository.js';

export class ProviderAccountService {
  public constructor(private readonly repository: ProviderAccountRepository) {}
  public resolveTenantId(provider: string, externalAccountRef: string): Promise<string | null> { return this.repository.resolveTenantId(provider, externalAccountRef); }
}
