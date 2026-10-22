import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { assertExecutableMeteringPolicy } from "../../src/modules/metering/metering-policy-artifact.js";
import type { MeteringPolicyRevisionDraft } from "../../src/modules/metering/metering-pricing-revision.types.js";

const CURRENT = {
  version: "2.0.0",
  artifactDigest:
    "7c5fd0b24d0a691cfcf769a981d8b4a8a689534d9b4ae1b5968342bde591094c",
} as const;
const RETIRED = {
  version: "1.0.0",
  artifactDigest:
    "ecd30d1908f410eed29181c9f52669f824312bf3a2e3874153d990b95fe58b91",
} as const;
function policy(
  overrides: Partial<MeteringPolicyRevisionDraft> = {},
): MeteringPolicyRevisionDraft {
  return {
    schemaVersion: "2",
    maxAttemptCredits: "10",
    tenantId: "qa-current-usage-profile",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    sourceRef: "QA current profile; not a real procurement tariff",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    profileRef: CURRENT,
    currencyCode: "USD",
    multiplier: { numerator: "7", denominator: "5" },
    creditMicrosPerMinor: { numerator: "100", denominator: "1" },
    roundingVersion: "attempt-credit-ceil-v2",
    failurePolicyRef: {
      version: "1.0.0",
      artifactDigest:
        "8d8dbe5950cfaa7f1383f847ad6e270c62bbd67bf02ea8717ac8d360594cb076",
    },
    ...overrides,
  };
}

describe("executable policy follows the current accepted Agent usage profile", () => {
  test("accepts the released usage2 aggregate, independently of the failure-policy version", () => {
    const manifest: unknown = JSON.parse(
      readFileSync("vendor/agent/usage/v2/manifest.json", "utf8"),
    );
    expect(manifest).toMatchObject({
      artifact_version: CURRENT.version,
      aggregate_sha256: CURRENT.artifactDigest,
    });
    expect(() => assertExecutableMeteringPolicy(policy())).not.toThrow();
  });

  test("does not reinterpret or accept the retired usage1 profile", () => {
    expect(() =>
      assertExecutableMeteringPolicy(policy({ profileRef: RETIRED })),
    ).toThrow();
  });

  test.each([
    { ...CURRENT, version: RETIRED.version },
    { ...RETIRED, version: CURRENT.version },
    { ...CURRENT, version: "3.0.0" },
    { ...CURRENT, artifactDigest: "a".repeat(64) },
    {
      ...CURRENT,
      artifactDigest:
        "552f0d22251837aaf4d83766c7bd91311984f707f9a42950ed53ac7127bb5504",
    },
  ])(
    "rejects a mismatched/unknown/schema-only profile reference %j",
    (profileRef) => {
      expect(() =>
        assertExecutableMeteringPolicy(policy({ profileRef })),
      ).toThrow();
    },
  );

  test.each<Partial<MeteringPolicyRevisionDraft>>([
    { failurePolicyRef: null },
    { failurePolicyRef: { version: "2.0.0", artifactDigest: "a".repeat(64) } },
    { multiplier: { numerator: "0", denominator: "1" } },
    { creditMicrosPerMinor: { numerator: "0", denominator: "1" } },
  ])(
    "preserves the executable failure-policy and nonzero money constraints %j",
    (override) => {
      expect(() => assertExecutableMeteringPolicy(policy(override))).toThrow();
    },
  );
});
