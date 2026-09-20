export type PriceQuote = Readonly<{
  revisionId: string;
  priceId: string;
  featureKey: string;
  quantity: bigint;
  unitPriceMicros: bigint;
  authorizedMicros: bigint;
  mode: "included" | "credit";
}>;
export type QuoteInput = Readonly<{
  tenantId: string;
  featureKey: string;
  quantity: bigint;
  at?: Date;
}>;
export type RecordUsageInput = Readonly<{
  tenantId: string;
  subjectId: string;
  sourceEventId: string;
  featureKey: string;
  quantity: bigint;
  dimensions?: unknown;
  holdId?: string;
}>;
export type SettleUsageInput = Readonly<{
  tenantId: string;
  actorId: string;
  holdId: string;
  sourceEventId: string;
  subjectId: string;
  featureKey: string;
  quantity: bigint;
  dimensions?: unknown;
  actualMicros: bigint;
}>;
export type UsageSettlementResult = Readonly<{
  usageEventId: string;
  settlementId: string;
  capturedMicros: bigint;
  releasedMicros: bigint;
}>;
