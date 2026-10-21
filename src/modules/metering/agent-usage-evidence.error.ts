export class AgentUsageEvidenceError extends Error {
  public readonly code = "EVIDENCE_INVALID";
  public constructor() {
    super("Agent usage evidence is invalid");
    this.name = "AgentUsageEvidenceError";
  }
}
