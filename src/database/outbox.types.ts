export const outboxNamespaces = ["credit", "payment"] as const;
export type OutboxNamespace = (typeof outboxNamespaces)[number];
export const registeredOutboxEventTypes = [
  "PaymentProviderEventReceived",
  "RefundCreditEffectRequested",
  "SubscriptionCreditGrantRequested",
] as const;
export type RegisteredOutboxEventType =
  (typeof registeredOutboxEventTypes)[number];

export type OutboxEnqueueInput = Readonly<{
  tenantId: string;
  namespace: "payment";
  aggregateType: string;
  aggregateId: string;
  eventType: RegisteredOutboxEventType;
  eventIdentity: string;
  payloadSchemaVersion: number;
  payloadDigest: string;
  payload: Readonly<Record<string, unknown>>;
  nextAttemptAt?: Date;
}>;

export type OutboxClaimInput = Readonly<{
  tenantId: string;
  namespace: "payment";
  eventTypes: readonly RegisteredOutboxEventType[];
  leaseMs: number;
  limit: number;
}>;

export type OutboxLease = Readonly<{
  id: string;
  tenantId: string;
  namespace: OutboxNamespace;
  eventType: string;
  eventIdentity: string;
  payloadSchemaVersion: number;
  payloadDigest: string;
  payload: unknown;
  leaseToken: string;
  leaseUntil: Date;
  attempts: number;
}>;

export type OutboxFence = Readonly<{
  tenantId: string;
  namespace: OutboxNamespace;
  id: string;
  leaseToken: string;
}>;

export type OutboxRequeueInput = Readonly<{
  tenantId: string;
  namespace: "payment";
  id: string;
  expectedGeneration: number;
  reason: string;
}>;
