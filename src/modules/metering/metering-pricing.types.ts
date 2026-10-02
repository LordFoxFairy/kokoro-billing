/** Billing-internal arithmetic inputs, not an Agent usage/wire contract. */
/** Nonnegative numerator, positive denominator; each at most 78 digits.
 * Exact calculated stages use reduced fractions within the same bound.
 */
export type MeteringRational = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

/** Roots and siblings declare mutually exclusive buckets. A child is included
 * in its parent's reported quantity; its total is subtracted exactly once.
 * Units must match along inclusion edges. The owner must verify this profile's
 * semantics against actual provider evidence before calling this pure helper.
 * One to 64 buckets; overlapping sets without a single-parent inclusion tree
 * must be disambiguated by the owner, never guessed by the arithmetic helper.
 */
export type MeteringUsageProfile = Readonly<{
  version: string;
  buckets: readonly Readonly<{
    key: string;
    unit: string;
    includedIn: string | null;
  }>[];
}>;

export type MeteringUsageQuantity = Readonly<{
  bucket: string;
  unit: string;
  /** null is unknown, never a free/zero quantity. */
  quantity: bigint | null;
}>;

export type MeteringBucketRate = Readonly<{
  bucket: string;
  unit: string;
  currencyCode: string;
  /** Exact currency minor units per one usage unit, possibly fractional. */
  minorPerUnit: MeteringRational;
}>;

export type MeteringPricingInput = Readonly<{
  profile: MeteringUsageProfile;
  usage: readonly MeteringUsageQuantity[];
  rates: readonly MeteringBucketRate[];
  multiplier: MeteringRational;
  conversion: Readonly<{
    currencyCode: string;
    /** Explicit Credit micros per currency minor unit; no implicit FX. */
    creditMicrosPerMinor: MeteringRational;
  }>;
}>;

export type MeteringPricingResult = Readonly<{
  profileVersion: string;
  currencyCode: string;
  normalizedUsage: readonly Readonly<{
    bucket: string;
    unit: string;
    quantity: bigint;
  }>[];
  procurementCostMinor: MeteringRational;
  salesCostMinor: MeteringRational;
  unroundedCreditMicros: MeteringRational;
  creditMicros: bigint;
  roundingVersion: "attempt-ceil-v1";
}>;
