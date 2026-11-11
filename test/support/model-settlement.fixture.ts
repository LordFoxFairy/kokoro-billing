import { assertDefined } from "../assert-defined.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ModelUsageEvidence } from "../../src/generated/agent-usage-v2/types.gen.js";
import type { MeteringFrozenPricing } from "../../src/modules/metering/metering-pricing-selection.types.js";
import {
  currentMeteringFailurePolicyRef,
  currentMeteringProfileRef,
} from "../../src/modules/metering/metering-policy-artifact.js";
export function canonicalFixture(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value))
      return `[${value.map(canonicalFixture).join(",")}]`;
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalFixture(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export const fixtureRevision = {
  id: "11111111-1111-4111-8111-111111111111",
  contentDigest: "b".repeat(64),
};
export function frozenPricingFixture(): MeteringFrozenPricing {
  const binding = {
    providerRef: "qa-provider",
    environment: "qa",
    pricingAccountRef: "qa-account",
    modelRef: "qa-model",
    modelVersion: "v1",
  };
  return {
    tenantId: "qa-tenant",
    modelRevision: { ...fixtureRevision },
    binding,
    dbNow: "2026-10-22T00:00:00.000Z",
    revisionId: "22222222-2222-4222-8222-222222222222",
    revision: "1",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    contentDigest: "c".repeat(64),
    profileRef: currentMeteringProfileRef,
    currencyCode: "USD",
    rates: ["input", "output"].map((bucket) => ({
      ...binding,
      modelRevision: { ...fixtureRevision },
      bucket,
      unit: "token",
      applicability: { kind: "all" },
      currencyCode: "USD",
      minorPerUnit: { numerator: "1", denominator: "10" },
    })),
    policy: {
      revisionId: "33333333-3333-4333-8333-333333333333",
      revision: "1",
      contentDigest: "d".repeat(64),
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      multiplier: { numerator: "7", denominator: "5" },
      creditMicrosPerMinor: { numerator: "1000000", denominator: "1" },
      maxAttemptCredits: "10",
      roundingVersion: "attempt-credit-ceil-v2",
      failurePolicyRef: currentMeteringFailurePolicyRef(),
    },
  };
}
export function usageFixture(): ModelUsageEvidence {
  const vectors = JSON.parse(
    readFileSync("vendor/agent/usage/v2/vectors.json", "utf8"),
  ) as { positive: { json_utf8: string }[] };
  const value = JSON.parse(
    assertDefined(vectors.positive[0]).json_utf8,
  ) as ModelUsageEvidence;
  value.identity.tenant_ref = "qa-tenant";
  value.identity.actor = { kind: "user", opaque_ref: "qa-user" };
  value.identity.subject = { ...value.identity.actor };
  value.planned.revision_id = fixtureRevision.id;
  value.planned.digest = fixtureRevision.contentDigest;
  value.actual = {
    state: "verified",
    provider_ref: value.planned.provider,
    model_ref: value.planned.model,
    evidence_ref: "qa-observation",
    evidence_digest: "e".repeat(64),
  };
  value.execution.outcome = "completed";
  if (value.usage.state !== "normalized") throw new Error("fixture");
  for (const key of ["input_total", "output_total"] as const)
    value.usage.value[key] = { state: "reported", count: "1" };
  for (const key of ["input_cache_read", "output_reasoning"] as const)
    value.usage.value[key] = { state: "reported", count: "0" };
  value.usage.value.total = { state: "reported", count: "2" };
  return value;
}
export function encodeUsageFixture(value: ModelUsageEvidence): string {
  const { digest: _digest, ...facts } = value;
  void _digest;
  value.digest = createHash("sha256")
    .update("kokoro-agent:model-usage-evidence:v2\n")
    .update(canonicalFixture(facts))
    .digest("hex");
  return canonicalFixture(value);
}
