export class MeteringError extends Error {
  constructor(
    readonly code:
      | "PRICE_UNAVAILABLE"
      | "USAGE_EVENT_MISMATCH"
      | "METERING_PUBLICATION_FORBIDDEN"
      | "METERING_PUBLICATION_CONFLICT"
      | "METERING_PUBLICATION_CORRUPT"
      | "METERING_PUBLICATION_REVISION_EXHAUSTED"
      | "METERING_PUBLICATION_UNAVAILABLE"
      | "METERING_SELECTION_INVALID"
      | "METERING_RATE_UNAVAILABLE"
      | "METERING_RATE_CORRUPT"
      | "METERING_RATE_AMBIGUOUS"
      | "METERING_POLICY_UNAVAILABLE"
      | "METERING_POLICY_CORRUPT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MeteringError";
  }
}
