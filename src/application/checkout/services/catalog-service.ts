import type { CatalogRepository } from '../ports/checkout-repository.js';

export type CatalogPlan = { readonly id: string; readonly key: string; readonly name: string; readonly currency: string; readonly amountMinor: string; readonly creditMicros: string; readonly billingInterval: 'once' | 'month' | 'year' };
export type CatalogPage = { readonly items: readonly CatalogPlan[]; readonly nextCursor?: string };

export class CatalogService {
  public constructor(private readonly repository: CatalogRepository) {}
  public listSellable(tenantId: string, limit = 50, cursor?: string): Promise<CatalogPage> { return this.repository.listSellable(tenantId, limit, cursor); }
  public listAdmin(tenantId: string, limit = 50, cursor?: string): Promise<CatalogPage> { return this.repository.listAdmin(tenantId, limit, cursor); }
}
