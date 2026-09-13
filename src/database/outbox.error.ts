export class OutboxError extends Error {
  constructor(
    readonly code: "OUTBOX_CONFLICT" | "OUTBOX_INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "OutboxError";
  }
}
