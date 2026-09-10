import type { TransactionPort } from "../../ports/transaction.js";
import type { GrantExpiryRepository } from "../ports/credit-repository.js";

export type GrantExpiryResult = { readonly expiredGrantIds: readonly string[] };
export class GrantExpiryService {
  public constructor(
    private readonly repository: GrantExpiryRepository,
    private readonly transaction: TransactionPort,
  ) {}
  public expireExpiredGrants(
    input: { readonly tenantId?: string; readonly limit?: number } = {},
  ): Promise<GrantExpiryResult> {
    return this.transaction.withTransaction(() =>
      this.repository.expireExpiredGrants(input),
    );
  }
}
