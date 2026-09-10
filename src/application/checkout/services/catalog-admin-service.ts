import type { TransactionPort } from "../../ports/transaction.js";
import type { CatalogAdminRepository } from "../ports/checkout-repository.js";
import type { CatalogPlan } from "./catalog-service.js";

export type PublishCatalogPlanInput = {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly offerKey: string;
  readonly name: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly creditMicros: number;
  readonly billingInterval: CatalogPlan["billingInterval"];
  readonly reason: string;
  readonly idempotencyKey: string;
};

export class CatalogAdminService {
  public constructor(
    private readonly repository: CatalogAdminRepository,
    private readonly transaction: TransactionPort,
  ) {}
  public publishPlan(input: PublishCatalogPlanInput): Promise<CatalogPlan> {
    return this.transaction.withTransaction(() =>
      this.repository.publishPlan(input),
    );
  }
}
