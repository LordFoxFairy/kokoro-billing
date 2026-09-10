import type { TransactionPort } from "../../ports/transaction.js";
import type { SubscriptionGrantRepository } from "../ports/credit-repository.js";

export type SubscriptionGrantInput = {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly accountId: string;
  readonly periodId: string;
  readonly programKey: string;
  readonly amountMicros: number;
  readonly expiresAt: Date;
};
export type CreditGrantResult = {
  readonly grantId: string;
  readonly journalId: string;
};
export class SubscriptionGrantService {
  public constructor(
    private readonly repository: SubscriptionGrantRepository,
    private readonly transaction: TransactionPort,
  ) {}
  public grant(input: SubscriptionGrantInput): Promise<CreditGrantResult> {
    return this.transaction.withTransaction(() => this.repository.grant(input));
  }
}
