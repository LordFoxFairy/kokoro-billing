import { assertDefined } from "../assert-defined.js";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { decodeFrozenModelPricing } from "../../src/modules/metering/model-settlement-snapshot.js";
import { priceSealedModelAttempt } from "../../src/modules/metering/model-settlement-pricing.js";
import { decodeAgentUsageEvidence } from "../../src/modules/metering/agent-usage-evidence.js";
import {
  canonicalFixture,
  frozenPricingFixture,
  usageFixture,
  encodeUsageFixture,
} from "../support/model-settlement.fixture.js";
function decode(value = frozenPricingFixture(), raw = canonicalFixture(value)) {
  return decodeFrozenModelPricing(
    raw,
    createHash("sha256").update(raw).digest("hex"),
    {
      tenantId: value.tenantId,
      modelRevision: value.modelRevision,
      budgetCredits: value.policy.maxAttemptCredits,
    },
  );
}
function price(
  edit?: (value: ReturnType<typeof usageFixture>) => void,
  snapshot = decode(),
) {
  const value = usageFixture();
  edit?.(value);
  return priceSealedModelAttempt(
    snapshot,
    decodeAgentUsageEvidence(Buffer.from(encodeUsageFixture(value))).evidence,
  );
}
describe("frozen model price to integer settlement", () => {
  test("strict immutable snapshot keeps full tariff subset identity, not full revision rehash", () => {
    const value = decode();
    expect(Object.isFrozen(value.rates[0])).toBe(true);
    expect(value.contentDigest).toBe("c".repeat(64));
  });
  test.each([
    "extra",
    "model",
    "currency",
    "profile",
    "budget",
    "rational",
    "effective",
    "duplicate",
  ])("rejects corrupted snapshot %s even after digest recompute", (change) => {
    const value = structuredClone(frozenPricingFixture());
    const row = assertDefined(value.rates[0]);
    const mutations = {
      extra: () => Object.assign(value, { alias: "unused" }),
      model: () =>
        Object.assign(row.modelRevision, {
          id: "44444444-4444-4444-8444-444444444444",
        }),
      currency: () => Object.assign(row, { currencyCode: "EUR" }),
      profile: () => Object.assign(value.profileRef, { version: "1.0.0" }),
      budget: () => Object.assign(value.policy, { maxAttemptCredits: "0" }),
      rational: () => Object.assign(row.minorPerUnit, { denominator: "0" }),
      effective: () =>
        Object.assign(value.policy, {
          effectiveFrom: "2026-12-01T00:00:00.000Z",
        }),
      duplicate: () => Object.assign(value, { rates: [...value.rates, row] }),
    };
    mutations[change as keyof typeof mutations]();
    expect(() => decode(value)).toThrow();
  });
  test("rejects digest mismatch, duplicate raw keys and noncanonical bytes", () => {
    const value = frozenPricingFixture(),
      raw = canonicalFixture(value);
    expect(() => decode(value, raw + " ")).toThrow();
    expect(() =>
      decode(
        value,
        raw.replace(
          '"tenantId":"qa-tenant"',
          '"tenantId":"bad","tenantId":"qa-tenant"',
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeFrozenModelPricing(raw, "f".repeat(64), {
        tenantId: value.tenantId,
        modelRevision: value.modelRevision,
        budgetCredits: "10",
      }),
    ).toThrow();
  });
  test("aggregate all buckets before one credit ceil", () => {
    expect(price()).toMatchObject({
      state: "actual_priced",
      actualCreditMicros: 1000000n,
      outcome: "completed",
    });
  });
  test.each(["completed", "failed", "cancelled"] as const)(
    "known actual is charged on %s",
    (outcome) =>
      expect(
        price((e) => {
          e.execution.outcome = outcome;
        }),
      ).toMatchObject({ state: "actual_priced", actualCreditMicros: 1000000n }),
  );
  test.each([
    "unknown_outcome",
    "unknown_attribution",
    "unsupported",
    "missing_usage",
    "unreported_cache",
    "unknown_bucket",
    "unknown_range",
  ])("valid unknown %s is not free or guessed", (kind) => {
    const snapshot = structuredClone(frozenPricingFixture());
    if (kind === "unknown_bucket")
      Object.assign(assertDefined(snapshot.rates[0]), { bucket: "unmapped" });
    if (kind === "unknown_range")
      Object.assign(assertDefined(snapshot.rates[0]), {
        applicability: {
          kind: "range",
          dimension: "unmapped",
          unit: "token",
          lowerInclusive: "0",
          upperExclusive: null,
        },
      });
    if (kind === "unreported_cache")
      Object.assign(snapshot, {
        rates: [
          ...snapshot.rates,
          { ...assertDefined(snapshot.rates[0]), bucket: "input_cache_read" },
        ],
      });
    expect(
      price((e) => {
        if (kind === "unknown_outcome") e.execution.outcome = "unknown";
        if (kind === "unknown_attribution")
          e.actual = { state: "unknown", reason: "unverified_binding" };
        if (kind === "missing_usage")
          e.usage = {
            state: "unresolved",
            reason: "missing_usage",
            raw_usage_digest: null,
          };
        if (e.usage.state === "normalized" && kind === "unsupported") {
          e.usage.value.profile_assessment = {
            state: "unsupported",
            reason: "unsupported_service_tier",
          };
          e.usage.value.classification_state = "unknown";
        }
        if (e.usage.state === "normalized" && kind === "unreported_cache")
          e.usage.value.input_cache_read = { state: "unreported" };
      }, decode(snapshot)),
    ).toEqual({ state: "unknown" });
  });
  test("valid int64 usage exceeding storable credits is known over budget", () => {
    expect(
      price((e) => {
        if (e.usage.state !== "normalized") throw new Error();
        e.usage.value.input_total = {
          state: "reported",
          count: "9223372036854775806",
        };
        e.usage.value.total = {
          state: "reported",
          count: "9223372036854775807",
        };
      }),
    ).toEqual({ state: "actual_exceeds_int64" });
  });
  test("bounded intermediate arithmetic failure remains unknown, not a guessed overcharge", () => {
    const snapshot = structuredClone(frozenPricingFixture());
    for (const row of snapshot.rates)
      Object.assign(row.minorPerUnit, {
        numerator: "1" + "0".repeat(77),
        denominator: "1",
      });
    expect(price(undefined, decode(snapshot))).toEqual({ state: "unknown" });
  });
  test.each(["provider", "model", "commercial_refs", "raw_model_name"])(
    "verified %s outside the supported actual System binding is unknown, not planned-price",
    (kind) => {
      expect(
        price((e) => {
          if (e.actual.state !== "verified") throw new Error();
          if (kind === "provider") e.actual.provider_ref = "other-provider";
          if (kind === "model") e.actual.model_ref = "other-model";
          if (kind === "commercial_refs") {
            e.actual.provider_ref = "qa-provider";
            e.actual.model_ref = "qa-model";
          }
          if (kind === "raw_model_name")
            e.actual.model_ref = e.planned.provider_model_name;
        }),
      ).toEqual({ state: "unknown" });
    },
  );
  test("zero usage remains known zero, while confirmed no dispatch releases", () => {
    expect(
      price((e) => {
        if (e.usage.state !== "normalized") throw new Error();
        for (const k of ["input_total", "output_total", "total"] as const)
          e.usage.value[k] = { state: "reported", count: "0" };
        e.usage.value.totals_state = "known_zero";
      }),
    ).toMatchObject({ state: "actual_priced", actualCreditMicros: 0n });
    expect(
      price((e) => {
        e.execution.outcome = "not_dispatched";
        e.execution.dispatch_started_at = null;
        e.actual = { state: "unknown", reason: "not_observed" };
        e.usage = {
          state: "unresolved",
          reason: "missing_usage",
          raw_usage_digest: null,
        };
      }),
    ).toEqual({ state: "confirmed_not_dispatched" });
  });
  test("explicit cache and reasoning subsets are subtracted once", () => {
    const snapshot = structuredClone(frozenPricingFixture());
    Object.assign(snapshot, {
      rates: [
        ...snapshot.rates,
        ...["input_cache_read", "output_reasoning"].map((bucket) => ({
          ...assertDefined(snapshot.rates[0]),
          bucket,
          minorPerUnit: { numerator: "0", denominator: "1" },
        })),
      ],
    });
    expect(
      price((e) => {
        if (e.usage.state !== "normalized") throw new Error();
        e.usage.value.input_cache_read = { state: "reported", count: "1" };
        e.usage.value.output_reasoning = { state: "reported", count: "1" };
      }, decode(snapshot)),
    ).toMatchObject({ state: "actual_priced", actualCreditMicros: 0n });
  });
  test("unsealed observations cannot release or charge a budget", () => {
    expect(() =>
      price((e) => {
        e.execution.seal = false;
      }),
    ).toThrow();
  });
  test("snapshot metadata has full-match digest and revision semantics", () => {
    const value = structuredClone(frozenPricingFixture());
    Object.assign(value, { revision: "1\n" });
    expect(() => decode(value)).toThrow();
    Object.assign(value, {
      revision: "1",
      contentDigest: "c".repeat(64) + "\n",
    });
    expect(() => decode(value)).toThrow();
  });
});
