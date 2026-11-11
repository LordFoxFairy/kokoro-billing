import type {
  AdminMeteringPricingResponse,
  MeteringPublicationResponse,
} from "../../generated/billing-api/types.gen.js";
import type { MeteringLatestPricing } from "./metering-pricing-revision.types.js";
import type { MeteringPricingPublicationResultV1 } from "./metering-pricing-publication-result-codec.js";

export function mapMeteringPublication(
  value: MeteringPricingPublicationResultV1<"rate" | "policy">,
): MeteringPublicationResponse {
  return {
    data: {
      kind: value.kind,
      revision: value.revision,
      content_digest: value.contentDigest,
      published_at: value.publishedAt,
      effective_from: value.effectiveFrom,
    },
  };
}
export function mapMeteringLatestPricing(
  value: MeteringLatestPricing,
): AdminMeteringPricingResponse {
  const { rate, policy } = value;
  return {
    data: {
      rate_revision:
        rate === null
          ? null
          : {
              revision: rate.revision,
              content_digest: rate.contentDigest,
              published_at: rate.publishedAt,
              configuration: {
                effective_from: rate.draft.effectiveFrom,
                source_ref: rate.draft.sourceRef,
                verified_at: rate.draft.verifiedAt,
                rates: rate.draft.rates.map((row) => ({
                  model_revision: {
                    id: row.modelRevision.id,
                    content_digest: row.modelRevision.contentDigest,
                  },
                  provider_ref: row.providerRef,
                  environment: row.environment,
                  pricing_account_ref: row.pricingAccountRef,
                  model_ref: row.modelRef,
                  model_version: row.modelVersion,
                  bucket: row.bucket,
                  unit: row.unit,
                  currency_code: row.currencyCode,
                  minor_per_unit: { ...row.minorPerUnit },
                  applicability:
                    row.applicability.kind === "all"
                      ? { kind: "all" }
                      : {
                          kind: "range",
                          dimension: row.applicability.dimension,
                          unit: row.applicability.unit,
                          lower_inclusive: row.applicability.lowerInclusive,
                          upper_exclusive: row.applicability.upperExclusive,
                        },
                })),
              },
            },
      policy_revision:
        policy === null
          ? null
          : {
              revision: policy.revision,
              content_digest: policy.contentDigest,
              published_at: policy.publishedAt,
              configuration: {
                effective_from: policy.draft.effectiveFrom,
                source_ref: policy.draft.sourceRef,
                verified_at: policy.draft.verifiedAt,
                currency_code: policy.draft.currencyCode,
                multiplier: { ...policy.draft.multiplier },
                credit_micros_per_minor: {
                  ...policy.draft.creditMicrosPerMinor,
                },
                max_attempt_credits: policy.draft.maxAttemptCredits,
              },
            },
    },
  };
}
