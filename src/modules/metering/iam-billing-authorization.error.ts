export const IAM_BILLING_AUTHORIZATION_ERROR_CODES = [
  "AUTHORIZATION_INVALID",
  "DENIED",
  "UNAVAILABLE",
  "BINDING_MISMATCH",
  "EXPIRED",
  "ABORTED",
  "SHUTTING_DOWN",
] as const;

export type IamBillingAuthorizationErrorCode =
  (typeof IAM_BILLING_AUTHORIZATION_ERROR_CODES)[number];

const messages = {
  AUTHORIZATION_INVALID: "Billing authorization request is invalid",
  DENIED: "Billing authorization was denied",
  UNAVAILABLE: "Billing authorization is unavailable",
  BINDING_MISMATCH: "Billing authorization binding does not match",
  EXPIRED: "Billing authorization has expired",
  ABORTED: "Billing authorization was aborted",
  SHUTTING_DOWN: "Billing authorization is shutting down",
} as const satisfies Record<IamBillingAuthorizationErrorCode, string>;

export class IamBillingAuthorizationError extends Error {
  public readonly retryable: boolean;

  public constructor(public readonly code: IamBillingAuthorizationErrorCode) {
    super(messages[code]);
    this.name = "IamBillingAuthorizationError";
    this.retryable = code === "UNAVAILABLE";
  }
}
