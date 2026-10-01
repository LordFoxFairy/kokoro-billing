export type CreditErrorCode =
  | "CREDIT_ACCOUNT_NOT_FOUND"
  | "CREDIT_ACCOUNT_DISABLED"
  | "CREDIT_INSUFFICIENT"
  | "CREDIT_HOLD_NOT_ACTIVE"
  | "CREDIT_HOLD_TERMINAL_CORRUPT"
  | "CREDIT_IDEMPOTENCY_CONFLICT";

export class CreditError extends Error {
  constructor(
    readonly code: CreditErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CreditError";
  }
}
