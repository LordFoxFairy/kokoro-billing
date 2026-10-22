import type { TransactionService } from "../../database/transaction.service.js";
import type { BillingAdminContext } from "../../infrastructure/auth/billing-auth.types.js";
import type { MeteringPricingRevisionRepository } from "./metering-pricing-revision.repository.js";
import { MeteringError } from "./metering.error.js";

export class MeteringPricingReadService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly repository: MeteringPricingRevisionRepository,
  ) {}
  readLatest(context: BillingAdminContext) {
    if (context.role !== "billing.admin")
      throw new MeteringError(
        "METERING_PUBLICATION_FORBIDDEN",
        "Metering management is forbidden",
      );
    return this.transactions.runRoot(
      {
        tenantId: context.tenantId,
        actorId: context.operatorId,
        operation: "metering.read_latest_pricing",
        mode: "readOnlySnapshot",
      },
      () => this.repository.readLatest(context.tenantId),
    );
  }
}
