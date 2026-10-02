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
export type HoldTerminalMutationResult = Readonly<{
  value: HoldTerminalResult;
  applied: boolean;
}>;
export type CreditAccountSnapshot = Readonly<{
  id: string;
  tenantId: string;
  subjectId: string;
  status: string;
  availableMicros: bigint;
  heldMicros: bigint;
}>;

export type CreditReadContext = Readonly<{
  tenantId: string;
  subjectId: string;
}>;
export type CreditLedgerPageInput = Readonly<{
  limit?: number;
  cursor?: string;
}>;
export type CreditLedgerCursor = CreditReadContext &
  Readonly<{
    version: 1;
    scope: "credit.ledger";
    accountId: string;
    highWaterSequence: bigint;
    lastSequence: bigint;
  }>;
export type CreditLedgerItem = Readonly<{
  journalId: string;
  sequence: bigint;
  deltaMicros: bigint;
  balanceAfterMicros: bigint;
  sourceKind: string;
  sourceRef: string;
  createdAt: Date;
}>;
export type CreditLedgerPage = Readonly<{
  items: readonly CreditLedgerItem[];
  nextCursor: string | null;
}>;
// Exact SQL text preserves numeric SUM(bigint); the nullable row is the
// LEFT JOIN sentinel used to carry history integrity even for an empty page.
export type CreditLedgerQueryRow = Readonly<{
  historyCorrupt: boolean;
  journalId: string | null;
  sequenceText: string | null;
  deltaText: string | null;
  balanceText: string | null;
  sourceKind: string | null;
  sourceRef: string | null;
  createdAt: Date | null;
}>;
export type CreditLedgerIntegrity = Readonly<{
  wrongTenant: boolean;
  invalidRow: boolean;
}>;
