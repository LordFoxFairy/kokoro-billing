import { describe, expect, test } from "vitest";
import {
  decodeMeteringPolicyRevisionDraft,
  encodeMeteringPolicyPublicationCommand,
  encodeMeteringPolicyRevisionDraft,
} from "../../src/modules/metering/metering-pricing-revision-codec.js";

const old = {
  schemaVersion: "1",
  tenantId: "tenant-budget",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  sourceRef: "QA budget fixture, not a procurement price",
  verifiedAt: "2026-01-01T00:00:00.000Z",
  profileRef: { version: "2.0.0", artifactDigest: "a".repeat(64) },
  currencyCode: "USD",
  multiplier: { numerator: "7", denominator: "5" },
  creditMicrosPerMinor: { numerator: "100", denominator: "1" },
  roundingVersion: "attempt-credit-ceil-v2",
  failurePolicyRef: null,
};
const current = { ...old, schemaVersion: "2", maxAttemptCredits: "10" };

function tuple(encoded: string): readonly unknown[] {
  const value: unknown = JSON.parse(encoded);
  if (
    value === null ||
    typeof value !== "object" ||
    !("value" in value) ||
    !Array.isArray(value.value)
  )
    throw new Error("Invalid encoded fixture tuple");
  return value.value as unknown[];
}

describe("immutable current policy includes its whole-credit attempt budget", () => {
  test.each(["1", "10", "9223372036854"])(
    "round trips an explicit budget %s without rounding or defaulting",
    (budget) => {
      const input = { ...current, maxAttemptCredits: budget };
      const encoded = encodeMeteringPolicyRevisionDraft(input);
      expect(decodeMeteringPolicyRevisionDraft(encoded.canonicalJson)).toEqual(
        input,
      );
      expect(tuple(encoded.canonicalJson)).toHaveLength(13);
      expect(tuple(encoded.canonicalJson)[12]).toBe(budget);
    },
  );
  test("does not accept a former budgetless policy or silently inject a budget", () => {
    expect(() => encodeMeteringPolicyRevisionDraft(old)).toThrow();
    const { maxAttemptCredits: omitted, ...missing } = current;
    expect(omitted).toBe("10");
    expect(() => encodeMeteringPolicyRevisionDraft(missing)).toThrow();
    expect(() =>
      encodeMeteringPolicyRevisionDraft({ ...old, maxAttemptCredits: "10" }),
    ).toThrow();
  });
  test.each([
    undefined,
    null,
    "0",
    "-1",
    "01",
    "1.0",
    "1e3",
    "9223372036855",
    "10\n",
    10,
    10n,
  ])("rejects invalid or noncanonical budget %s", (budget) => {
    expect(() =>
      encodeMeteringPolicyRevisionDraft({
        ...current,
        maxAttemptCredits: budget,
      }),
    ).toThrow();
  });
  test("binds the exact budget to both content and publication command digests", () => {
    const command = {
      tenantId: current.tenantId,
      actorId: "operator-budget",
      publicationIdentity: "publication-budget",
      idempotencyKey: "budget-key",
      reason: "QA immutable budget",
      draft: current,
    };
    const first = encodeMeteringPolicyPublicationCommand(command);
    const changed = encodeMeteringPolicyPublicationCommand({
      ...command,
      draft: { ...current, maxAttemptCredits: "11" },
    });
    expect(first.requestSchemaVersion).toBe(2);
    expect(first.contentDigest).not.toBe(changed.contentDigest);
    expect(first.payloadDigest).not.toBe(changed.payloadDigest);
    expect(tuple(first.canonicalJson)[1]).toBe("2");
  });
});
