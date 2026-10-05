import type {
  MeteringRevisionRate,
  MeteringRevisionReference,
} from "./metering-pricing-revision.types.js";

export type MeteringRateSelectionBinding = Readonly<{
  providerRef: string;
  environment: string;
  pricingAccountRef: string;
  modelRef: string;
  modelVersion: string;
}>;

export type MeteringRateSelectionRequest = Readonly<{
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

export type MeteringRateSelectionInput = Readonly<{
  tenantId: string;
  profileRef: MeteringRevisionReference;
  binding: MeteringRateSelectionBinding;
  requests: readonly MeteringRateSelectionRequest[];
}>;

export type MeteringSelectedRate = Readonly<{
  request: MeteringRateSelectionRequest;
  rate: MeteringRevisionRate;
}>;

export type MeteringRateSelectionResult = Readonly<{
  tenantId: string;
  dbNow: string;
  revisionId: string;
  revision: string;
  effectiveFrom: string;
  contentDigest: string;
  profileRef: MeteringRevisionReference;
  currencyCode: string;
  rates: readonly MeteringSelectedRate[];
}>;
