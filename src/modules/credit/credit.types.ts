export type CommandMetadata = Readonly<{
  actorId: string;
  idempotencyKey: string;
  commandIdentity?: string;
}>;
export type GrantCreditEffectInput = Readonly<{
  tenantId: string;
  subjectId: string;
  amountMicros: bigint;
  sourceKind: string;
  sourceRef: string;
  programKey: string;
  effectiveAt: Date;
  expiresAt?: Date;
  burnPriority?: number;
}>;
export type GrantCreditInput = GrantCreditEffectInput & CommandMetadata;
export type GrantCreditResult = Readonly<{
  accountId: string;
  grantId: string;
  journalId: string;
}>;
export type ReserveCreditEffectInput = Readonly<{
  tenantId: string;
  accountId: string;
  idempotencyKey: string;
  requestedMicros: bigint;
  featureKey?: string;
  expiresAt: Date;
}>;
export type ReserveCreditInput = ReserveCreditEffectInput & CommandMetadata;
export type ReserveCreditResult = Readonly<{
  holdId: string;
  requestedMicros: bigint;
}>;
export type CaptureCreditInput = Readonly<{
  tenantId: string;
  holdId: string;
  actualMicros: bigint;
  sourceRef: string;
}>;
export type ReleaseCreditInput = Readonly<{
  tenantId: string;
  holdId: string;
  sourceRef: string;
}>;
export type HoldTerminalResult = Readonly<{
  holdId: string;
  accountId: string;
  capturedMicros: bigint;
  releasedMicros: bigint;
}>;
export type CreditAccountSnapshot = Readonly<{
  id: string;
  tenantId: string;
  subjectId: string;
  status: string;
  availableMicros: bigint;
  heldMicros: bigint;
}>;
