import type { Checkout, CreateCheckoutInput } from '../commands/checkout-service.js';
import type { PublishCatalogPlanInput } from '../services/catalog-admin-service.js';
import type { CatalogPage, CatalogPlan } from '../services/catalog-service.js';

export interface CheckoutRepository {
  create(input: CreateCheckoutInput): Promise<Checkout>;
  createHostedSession(tenantId: string, checkoutId: string): Promise<Checkout>;
}

export interface CatalogRepository {
  listSellable(tenantId: string, limit: number, cursor?: string): Promise<CatalogPage>;
  listAdmin(tenantId: string, limit: number, cursor?: string): Promise<CatalogPage>;
}

export interface CatalogAdminRepository {
  publishPlan(input: PublishCatalogPlanInput): Promise<CatalogPlan>;
}
