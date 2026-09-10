import type { TransactionPort } from "../../ports/transaction.js";
import type { CreditAccountRepository } from "../ports/credit-repository.js";

export class CreditAccountQueryService {
  public constructor(
    private readonly repository: CreditAccountRepository,
    private readonly transaction: TransactionPort,
  ) {}
  public ensureForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<{ readonly accountId: string }> {
    return this.transaction.withTransaction(() =>
      this.repository.ensureForSubject(tenantId, subjectId),
    );
  }
  public getForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.repository.getForSubject(tenantId, subjectId);
  }
  public summaryForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<{
    balanceMicros: string;
    heldMicros: string;
    quotaMicros: string | null;
    quotaPeriod: string | null;
  }> {
    return this.repository.summaryForSubject(tenantId, subjectId);
  }
  public ledgerForSubject(
    tenantId: string,
    subjectId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ entries: unknown[]; nextCursor?: string }> {
    return this.repository.ledgerForSubject(tenantId, subjectId, limit, cursor);
  }
  public byModelForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<{ periodStart: string; items: unknown[] }> {
    return this.repository.byModelForSubject(tenantId, subjectId);
  }
}
