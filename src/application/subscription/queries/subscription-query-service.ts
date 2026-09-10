import type { SubscriptionRepository } from "../ports/subscription-repository.js";

export type SubscriptionView = {
  readonly subscriptionId: string;
  readonly status: string;
  readonly planKey: string;
  readonly periodStart: string;
  readonly periodEnd: string;
};
export type SubscriptionPage = {
  readonly items: readonly SubscriptionView[];
  readonly nextCursor?: string;
};
export class SubscriptionQueryService {
  public constructor(private readonly repository: SubscriptionRepository) {}
  public listForSubject(
    tenantId: string,
    subjectId: string,
    limit = 50,
    cursor?: string,
  ): Promise<SubscriptionPage> {
    return this.repository.listForSubject(tenantId, subjectId, limit, cursor);
  }
}
