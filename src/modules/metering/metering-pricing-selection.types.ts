import type {
  MeteringPolicyRevisionDraft,
  MeteringRevisionRate,
  MeteringRevisionReference,
} from "./metering-pricing-revision.types.js";

export type MeteringPricingSelectionBinding = Readonly<{
  providerRef: string;
  environment: string;
  pricingAccountRef: string;
  modelRef: string;
  modelVersion: string;
}>;

export type MeteringPricingSelectionRequest = Readonly<{
  bucket: string;
  unit: string;
  applicability:
    | Readonly<{ kind: "all" }>
    | Readonly<{
        kind: "range";
        dimension: string;
        unit: string;
        value: string;
      }>;
}>;

export type MeteringPricingSelectionInput = Readonly<{
  tenantId: string;
  profileRef: MeteringRevisionReference;
  binding: MeteringPricingSelectionBinding;
  requests: readonly MeteringPricingSelectionRequest[];
}>;

export type MeteringSelectedRate = Readonly<{
  request: MeteringPricingSelectionRequest;
  rate: MeteringRevisionRate;
}>;

export type MeteringPricingSelectionResult = Readonly<{
  tenantId: string;
  dbNow: string;
  revisionId: string;
  revision: string;
  effectiveFrom: string;
  contentDigest: string;
  profileRef: MeteringRevisionReference;
  currencyCode: string;
  rates: readonly MeteringSelectedRate[];
  policy: Readonly<{
    revisionId: string;
    revision: string;
    contentDigest: string;
    effectiveFrom: string;
    multiplier: MeteringPolicyRevisionDraft["multiplier"];
    creditMicrosPerMinor: MeteringPolicyRevisionDraft["creditMicrosPerMinor"];
    roundingVersion: MeteringPolicyRevisionDraft["roundingVersion"];
    failurePolicyRef: MeteringRevisionReference;
  }>;
}>;
