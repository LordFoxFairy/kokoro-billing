export type CreditGrantForAllocation = {
  readonly grantId: string;
  readonly availableMicros: number;
  readonly expiresAt: string | null;
  readonly burnPriority: number;
  readonly issuedAt: string;
};

export type CreditGrantAllocation = {
  readonly grantId: string;
  readonly amountMicros: number;
};

export class InsufficientCreditError extends Error {
  readonly code = "billing.insufficient_credit";

  constructor(requestedMicros: number, availableMicros: number) {
    super(
      `insufficient credit: requested ${requestedMicros}, available ${availableMicros}`,
    );
    this.name = "InsufficientCreditError";
  }
}

const compareNullableExpiry = (
  left: string | null,
  right: string | null,
): number => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
};

export const allocateCreditGrants = (
  grants: readonly CreditGrantForAllocation[],
  requestedMicros: number,
): CreditGrantAllocation[] => {
  if (!Number.isSafeInteger(requestedMicros) || requestedMicros <= 0) {
    throw new RangeError("requestedMicros must be a positive safe integer");
  }

  const ordered = [...grants]
    .filter((grant) => grant.availableMicros > 0)
    .sort(
      (left, right) =>
        compareNullableExpiry(left.expiresAt, right.expiresAt) ||
        left.burnPriority - right.burnPriority ||
        left.issuedAt.localeCompare(right.issuedAt) ||
        left.grantId.localeCompare(right.grantId),
    );

  const availableMicros = ordered.reduce(
    (sum, grant) => sum + grant.availableMicros,
    0,
  );
  if (availableMicros < requestedMicros) {
    throw new InsufficientCreditError(requestedMicros, availableMicros);
  }

  let remaining = requestedMicros;
  const allocations: CreditGrantAllocation[] = [];
  for (const grant of ordered) {
    if (remaining === 0) break;
    const amountMicros = Math.min(remaining, grant.availableMicros);
    allocations.push({ grantId: grant.grantId, amountMicros });
    remaining -= amountMicros;
  }
  return allocations;
};
