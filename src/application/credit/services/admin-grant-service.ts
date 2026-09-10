import type { TransactionPort } from "../../ports/transaction.js";
import type { AdminGrantRepository } from "../ports/credit-repository.js";

export type AdminGrantInput = {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly accountId: string;
  readonly amountMicros: number;
  readonly programKey: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
};
export type AdminGrantResult = {
  readonly grantId: string;
  readonly journalId: string;
};

export class AdminGrantService {
  public constructor(
    private readonly repository: AdminGrantRepository,
    private readonly transaction: TransactionPort,
  ) {}
  public grant(input: AdminGrantInput): Promise<AdminGrantResult> {
    return this.transaction.withTransaction(() => this.repository.grant(input));
  }
}
