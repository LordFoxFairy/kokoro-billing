import { describe, expect, test } from "vitest";
import { decideModelAttemptSettlement } from "../../src/modules/metering/model-attempt-settlement.js";
import type { ModelAttemptSettlementKnowledge } from "../../src/modules/metering/model-attempt-settlement.js";

const CREDIT = 1_000_000n;
const MAX_CREDITS = 9_223_372_036_854n;
const known = (
  actualCreditMicros: bigint,
  outcome: "completed" | "failed" | "cancelled" = "completed",
): ModelAttemptSettlementKnowledge => ({
  state: "actual_priced",
  outcome,
  actualCreditMicros,
});

describe("one-attempt budget settlement after trusted usage verification", () => {
  test.each(["completed", "failed", "cancelled"] as const)(
    "%s captures verified actual once and releases only the unused reservation",
    (outcome) => {
      expect(
        decideModelAttemptSettlement(10n * CREDIT, known(3n * CREDIT, outcome)),
      ).toEqual({
        action: "capture",
        captureMicros: 3n * CREDIT,
        releaseMicros: 7n * CREDIT,
      });
    },
  );
  test.each([0n, 10n * CREDIT])(
    "known actual %s is not an unknown or a per-chunk rounding",
    (actual) => {
      expect(decideModelAttemptSettlement(10n * CREDIT, known(actual))).toEqual(
        {
          action: "capture",
          captureMicros: actual,
          releaseMicros: 10n * CREDIT - actual,
        },
      );
    },
  );
  test("only confirmed not-dispatched releases without an actual cost", () => {
    expect(
      decideModelAttemptSettlement(10n * CREDIT, {
        state: "confirmed_not_dispatched",
      }),
    ).toEqual({
      action: "release",
      releaseMicros: 10n * CREDIT,
    });
  });
  test("unknown keeps the complete reservation, rather than manufacturing a zero/cancellation", () => {
    expect(
      decideModelAttemptSettlement(10n * CREDIT, { state: "unknown" }),
    ).toEqual({
      action: "pending_reconciliation",
      reason: "unknown_usage_or_outcome",
      retainedMicros: 10n * CREDIT,
    });
  });
  test("actual over budget retains the hold; no clamp, excess debit, release or new dispatch", () => {
    expect(
      decideModelAttemptSettlement(10n * CREDIT, known(11n * CREDIT)),
    ).toEqual({
      action: "pending_reconciliation",
      reason: "budget_exceeded",
      retainedMicros: 10n * CREDIT,
    });
  });
  test("maximum whole-credit int64 boundary stays exact", () => {
    const budget = MAX_CREDITS * CREDIT;
    expect(decideModelAttemptSettlement(budget, known(budget))).toEqual({
      action: "capture",
      captureMicros: budget,
      releaseMicros: 0n,
    });
  });
  test.each([0n, -CREDIT, 1n, CREDIT + 1n, (MAX_CREDITS + 1n) * CREDIT])(
    "rejects invalid budget %s without money arithmetic",
    (budget) => {
      expect(() =>
        decideModelAttemptSettlement(budget, known(CREDIT)),
      ).toThrow();
    },
  );
  test.each([-CREDIT, 1n, CREDIT + 1n, (MAX_CREDITS + 1n) * CREDIT])(
    "rejects invalid priced actual %s instead of re-rounding it",
    (actual) => {
      expect(() =>
        decideModelAttemptSettlement(10n * CREDIT, known(actual)),
      ).toThrow();
    },
  );
  test("rejects number amounts instead of silently accepting an imprecise money representation", () => {
    expect(() =>
      decideModelAttemptSettlement(1_000_000 as unknown as bigint, known(0n)),
    ).toThrow();
    expect(() =>
      decideModelAttemptSettlement(CREDIT, known(0 as unknown as bigint)),
    ).toThrow();
  });
  test("rejects an unknown knowledge tag or a priced-but-unknown outcome", () => {
    for (const value of [
      { state: "legacy_free" },
      { state: "actual_priced", outcome: "unknown", actualCreditMicros: 0n },
    ])
      expect(() =>
        decideModelAttemptSettlement(
          CREDIT,
          value as ModelAttemptSettlementKnowledge,
        ),
      ).toThrow();
  });
  test("is deterministic and returns immutable decisions, not a debit receipt", () => {
    const observation = Object.freeze(known(3n * CREDIT));
    const first = decideModelAttemptSettlement(10n * CREDIT, observation);
    expect(Object.isFrozen(first)).toBe(true);
    expect(decideModelAttemptSettlement(10n * CREDIT, observation)).toEqual(
      first,
    );
    expect(observation).toEqual(known(3n * CREDIT));
  });
});
