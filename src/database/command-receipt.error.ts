export class CommandReceiptError extends Error {
  constructor(
    readonly code:
      | "COMMAND_IDEMPOTENCY_CONFLICT"
      | "COMMAND_RECEIPT_CORRUPT"
      | "COMMAND_RECEIPT_INCOMPLETE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandReceiptError";
  }
}
