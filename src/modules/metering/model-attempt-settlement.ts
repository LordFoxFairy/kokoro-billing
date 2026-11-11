/** Facts have already passed owner evidence/profile checks; never a browser DTO. */
export type ModelAttemptSettlementKnowledge =
  | Readonly<{ state: "confirmed_not_dispatched" }>
  | Readonly<{ state: "unknown" }>
  | Readonly<{ state: "actual_exceeds_int64" }>
  | Readonly<{
      state: "actual_priced";
      outcome: "completed" | "failed" | "cancelled";
      actualCreditMicros: bigint;
    }>;

export type ModelAttemptSettlementDecision =
  | Readonly<{ action: "release"; releaseMicros: bigint }>
  | Readonly<{
      action: "capture";
      captureMicros: bigint;
      releaseMicros: bigint;
    }>
  | Readonly<{
      action: "pending_reconciliation";
      reason: "unknown_usage_or_outcome" | "budget_exceeded";
      retainedMicros: bigint;
    }>;

/** Pure policy only: no evidence authentication, hold write or dispatch permit. */
export function decideModelAttemptSettlement(
  budgetMicros: bigint,
  knowledge: ModelAttemptSettlementKnowledge,
): ModelAttemptSettlementDecision {
  const creditMicros = 1_000_000n;
  const maximum = 9_223_372_036_854_775_807n;
  const whole = (value: bigint, positive: boolean): void => {
    if (
      typeof value !== "bigint" ||
      value < (positive ? creditMicros : 0n) ||
      value > maximum ||
      value % creditMicros !== 0n
    )
      throw new RangeError("Expected whole-credit amount within int64");
  };
  whole(budgetMicros, true);
  switch (knowledge.state) {
    case "confirmed_not_dispatched":
      return Object.freeze({ action: "release", releaseMicros: budgetMicros });
    case "unknown":
      return Object.freeze({
        action: "pending_reconciliation",
        reason: "unknown_usage_or_outcome",
        retainedMicros: budgetMicros,
      });
    case "actual_exceeds_int64":
      return Object.freeze({
        action: "pending_reconciliation",
        reason: "budget_exceeded",
        retainedMicros: budgetMicros,
      });
    case "actual_priced": {
      if (!["completed", "failed", "cancelled"].includes(knowledge.outcome))
        throw new TypeError("Priced actual requires a known terminal outcome");
      const actual = knowledge.actualCreditMicros;
      whole(actual, false);
      if (actual > budgetMicros)
        return Object.freeze({
          action: "pending_reconciliation",
          reason: "budget_exceeded",
          retainedMicros: budgetMicros,
        });
      return Object.freeze({
        action: "capture",
        captureMicros: actual,
        releaseMicros: budgetMicros - actual,
      });
    }
    default:
      throw new TypeError("Unknown model-attempt settlement knowledge");
  }
}
