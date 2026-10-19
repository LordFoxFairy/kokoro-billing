export type AgentUsageReaderErrorCode =
  | "CONFIG_INVALID"
  | "REQUEST_INVALID"
  | "CONTRACT_INVALID"
  | "DENIED"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "ABORTED"
  | "SHUTTING_DOWN";

/** Deliberately excludes upstream URL, credential, body and cause. */
export class AgentUsageReaderError extends Error {
  public constructor(public readonly code: AgentUsageReaderErrorCode) {
    super(`Agent usage evidence read failed: ${code}`);
    this.name = "AgentUsageReaderError";
  }
}
