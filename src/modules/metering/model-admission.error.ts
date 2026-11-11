export class ModelAdmissionError extends Error {
  constructor(
    readonly code:
      | "INVALID"
      | "FORBIDDEN"
      | "EXPIRED"
      | "RUN_BLOCKED"
      | "CONFLICT"
      | "CORRUPT"
      | "UNAVAILABLE"
      | "ABORTED",
  ) {
    super(`Model admission failed: ${code}`);
    this.name = "ModelAdmissionError";
  }
}
