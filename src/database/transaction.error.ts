export const transactionErrorCodes = [
  "TRANSACTION_REQUIRED",
  "TRANSACTION_CONTEXT_MISMATCH",
  "TRANSACTION_MODE_MISMATCH",
  "TRANSACTION_CONTEXT_CLOSED",
  "TRANSACTION_ALREADY_ACTIVE",
  "ROOT_READ_ONLY",
  "DATABASE_NOT_READY",
] as const;

export type TransactionErrorCode = (typeof transactionErrorCodes)[number];

export class TransactionContextError extends Error {
  readonly code: TransactionErrorCode;

  constructor(
    code: TransactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransactionContextError";
    this.code = code;
  }
}

export function preserveTransactionFailure(
  primary: unknown,
  secondary: unknown,
): AggregateError {
  return new AggregateError(
    [primary, secondary],
    "Transaction rollback failed after the primary error",
    { cause: primary },
  );
}
