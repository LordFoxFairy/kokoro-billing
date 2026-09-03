import type { SubscriptionPage } from '../queries/subscription-query-service.js';

export interface SubscriptionRepository {
  listForSubject(tenantId: string, subjectId: string, limit: number, cursor?: string): Promise<SubscriptionPage>;
}
