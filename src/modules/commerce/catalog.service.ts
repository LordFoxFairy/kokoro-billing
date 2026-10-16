import type { TransactionService } from "../../database/transaction.service.js";
import type { BillingCatalogContext } from "../../infrastructure/auth/billing-auth.types.js";
import type { CatalogQuery } from "./catalog.query.js";
import type { CatalogRepository } from "./catalog.repository.js";

export class CatalogService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly repository: CatalogRepository,
  ) {}
  list(context: BillingCatalogContext, query: CatalogQuery) {
    return this.transactions.runRoot(
      {
        tenantId: context.tenantId,
        actorId: context.actorId,
        operation: "commerce.catalog.list",
        mode: "readOnlySnapshot",
      },
      () => this.repository.list(context.tenantId, query),
    );
  }
}
