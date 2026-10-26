/** No supplied material or upstream cause may escape the metering boundary. */
export class AgentModelCallBoundError extends Error {
  public constructor() {
    super("Agent model call bound is invalid");
    this.name = "AgentModelCallBoundError";
  }
}
