import { describe, expect, test } from "vitest";
import { mapModelSettlement } from "../../src/modules/metering/model-settlement.mapper.js";
import type { ModelSettlementResult } from "../../src/modules/metering/model-settlement-codec.js";
const value: ModelSettlementResult = {
  schemaVersion: 1,
  admissionId: "11111111-1111-4111-8111-111111111111",
  runId: "qa-run",
  attemptId: "22222222-2222-4222-8222-222222222222",
  eventId: "33333333-3333-4333-8333-333333333333",
  revision: "1",
  digest: "a".repeat(64),
  status: "pending_reconciliation",
  reason: "unknown_usage_or_outcome",
  capturedMicros: "0",
  releasedMicros: "0",
  usageEventId: null,
  settlementId: null,
  updatedAt: "2026-10-22T00:00:00.000Z",
  evidenceJson: "private observation",
};
describe("model settlement safe integer projection", () => {
  test("whole credit precision and original correlation survive, private evidence does not", () => {
    const mapped = mapModelSettlement({
      ...value,
      capturedMicros: "9223372036854000000",
      status: "captured",
      reason: null,
      usageEventId: value.eventId,
      settlementId: value.eventId,
    });
    expect(mapped.data).toMatchObject({
      run_id: value.runId,
      attempt_id: value.attemptId,
      captured_credits: "9223372036854",
      released_credits: "0",
    });
    expect(JSON.stringify(mapped)).not.toContain(value.evidenceJson);
    expect(JSON.stringify(mapped)).not.toContain("evidenceJson");
  });
  test.each([
    { capturedMicros: "1000000" },
    { releasedMicros: "1000000" },
    { reason: null },
    { usageEventId: value.eventId },
    { settlementId: value.eventId },
  ])(
    "rejects inconsistent pending result instead of projecting a false ACK",
    (patch) =>
      expect(() => mapModelSettlement({ ...value, ...patch })).toThrow(),
  );
  test.each([
    "1",
    "1000001",
    "-1000000",
    "01000000",
    "9223372036855000000",
    "1\n",
  ])("refuses non-canonical or non-integer credit amount %s", (amount) =>
    expect(() =>
      mapModelSettlement({ ...value, capturedMicros: amount }),
    ).toThrow(),
  );
});
