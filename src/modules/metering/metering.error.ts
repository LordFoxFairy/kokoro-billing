export class MeteringError extends Error {
  constructor(
    readonly code: "PRICE_UNAVAILABLE" | "USAGE_EVENT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "MeteringError";
  }
}
