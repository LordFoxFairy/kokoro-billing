import { ModelAdmissionError } from "./model-admission.error.js";
import type {
  ModelUsageEvidence,
  TokenUsageV1,
} from "../../generated/agent-usage-v2/types.gen.js";
import type { Frozen } from "./agent-usage-evidence.js";
import type { MeteringFrozenPricing } from "./metering-pricing-selection.types.js";
import type { ModelAttemptSettlementKnowledge } from "./model-attempt-settlement.js";
import {
  priceMeteredAttempt,
  MeteringCreditOverflowError,
} from "./metering-pricing.js";

const buckets = {
  input: { count: "input_total", includedIn: null },
  output: { count: "output_total", includedIn: null },
  input_cache_read: { count: "input_cache_read", includedIn: "input" },
  input_cache_write: { count: "input_cache_write", includedIn: "input" },
  output_reasoning: { count: "output_reasoning", includedIn: "output" },
} as const;
const dimensions = [
  "input_total",
  "output_total",
  "total",
  "input_cache_read",
  "input_cache_write",
  "output_reasoning",
] as const;
function count(usage: Frozen<TokenUsageV1>, key: string): bigint | null {
  const dimension = dimensions.find((d) => d === key);
  if (dimension === undefined) return null;
  const value = usage[dimension];
  return value.state === "reported" ? BigInt(value.count) : null;
}
/** Facts are already owner-validated; unsupported/missing business knowledge is never zero. */
export function priceSealedModelAttempt(
  snapshot: MeteringFrozenPricing,
  e: Frozen<ModelUsageEvidence>,
): ModelAttemptSettlementKnowledge {
  if (!e.execution.seal) throw new ModelAdmissionError("CORRUPT");
  if (
    e.execution.outcome === "not_dispatched" &&
    e.execution.dispatch_started_at === null
  )
    return { state: "confirmed_not_dispatched" };
  const outcome = e.execution.outcome;
  if (
    !["completed", "failed", "cancelled"].includes(outcome) ||
    e.actual.state !== "verified" ||
    e.usage.state !== "normalized"
  )
    return { state: "unknown" };
  if (
    outcome !== "completed" &&
    outcome !== "failed" &&
    outcome !== "cancelled"
  )
    return { state: "unknown" };
  // This budget profile supports only the authenticated System-directory mapping
  // defined by the Agent/Billing business contract, never raw or commercial refs.
  if (
    e.actual.provider_ref !== e.planned.provider ||
    e.actual.model_ref !== e.planned.model
  )
    return { state: "unknown" };
  const usage = e.usage.value;
  if (
    usage.profile_assessment.state !== "supported" ||
    usage.totals_state === "unknown"
  )
    return { state: "unknown" };
  const keys = [...new Set(snapshot.rates.map((r) => r.bucket))];
  if (!keys.includes("input") || !keys.includes("output"))
    return { state: "unknown" };
  const mapped = [];
  for (const key of keys) {
    const name = (Object.keys(buckets) as (keyof typeof buckets)[]).find(
      (n) => n === key,
    );
    if (name === undefined) return { state: "unknown" };
    const bucket = buckets[name],
      quantity = count(usage, bucket.count);
    if (quantity === null) return { state: "unknown" };
    const rates = snapshot.rates.filter((r) => {
      if (r.bucket !== key || r.unit !== "token") return false;
      const a = r.applicability;
      if (a.kind === "all") return true;
      const v = count(usage, a.dimension);
      return (
        a.unit === "token" &&
        v !== null &&
        v >= BigInt(a.lowerInclusive) &&
        (a.upperExclusive === null || v < BigInt(a.upperExclusive))
      );
    });
    if (rates.length !== 1) return { state: "unknown" };
    const rate = rates[0];
    if (!rate) return { state: "unknown" };
    mapped.push({
      key,
      unit: "token",
      includedIn: bucket.includedIn,
      quantity,
      rate,
    });
  }
  const ratio = (r: {
    readonly numerator: string;
    readonly denominator: string;
  }) => ({
    numerator: BigInt(r.numerator),
    denominator: BigInt(r.denominator),
  });
  try {
    const priced = priceMeteredAttempt({
      profile: {
        version: "token_usage_v1",
        buckets: mapped.map(({ key, unit, includedIn }) => ({
          key,
          unit,
          includedIn,
        })),
      },
      usage: mapped.map(({ key, unit, quantity }) => ({
        bucket: key,
        unit,
        quantity,
      })),
      rates: mapped.map(({ key, unit, rate }) => ({
        bucket: key,
        unit,
        currencyCode: rate.currencyCode,
        minorPerUnit: ratio(rate.minorPerUnit),
      })),
      multiplier: ratio(snapshot.policy.multiplier),
      conversion: {
        currencyCode: snapshot.currencyCode,
        creditMicrosPerMinor: ratio(snapshot.policy.creditMicrosPerMinor),
      },
    });
    return {
      state: "actual_priced",
      outcome,
      actualCreditMicros: priced.creditMicros,
    };
  } catch (error) {
    if (error instanceof MeteringCreditOverflowError)
      return { state: "actual_exceeds_int64" };
    // A bounded intermediate failure does not prove the eventual converted cost.
    if (error instanceof RangeError) return { state: "unknown" };
    throw error;
  }
}
