import type {
  MeteringPricingInput,
  MeteringPricingResult,
  MeteringRational,
} from "./metering-pricing.types.js";

const INT64_MAX = 9_223_372_036_854_775_807n;
const NUMERIC_MAX = 10n ** 78n - 1n;
const MAX_BUCKETS = 64;

function shape(value: unknown, keys: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError("Invalid metering pricing shape");
}

function identifier(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value)
  )
    throw new TypeError("Invalid metering pricing identifier or unit");
}

function currency(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value))
    throw new TypeError("Invalid metering pricing currency");
}

function collection(value: unknown): void {
  if (!Array.isArray(value))
    throw new TypeError("Missing metering pricing collection");
  if (value.length < 1 || value.length > MAX_BUCKETS)
    throw new RangeError("Metering pricing requires 1 to 64 buckets");
}

function nonnegative(value: unknown, maximum: bigint): asserts value is bigint {
  if (typeof value !== "bigint")
    throw new TypeError("Metering pricing requires known bigint values");
  if (value < 0n || value > maximum)
    throw new RangeError("Metering pricing value outside exact numeric range");
}

function validateRatio(value: MeteringRational, positive: boolean): void {
  shape(value, ["numerator", "denominator"]);
  nonnegative(value.numerator, NUMERIC_MAX);
  nonnegative(value.denominator, NUMERIC_MAX);
  if (value.denominator === 0n || (positive && value.numerator === 0n))
    throw new RangeError("Metering pricing requires a positive ratio");
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fraction(numerator: bigint, denominator: bigint): MeteringRational {
  const divisor = gcd(numerator, denominator);
  const result = {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
  // Canonical exact stages are persisted as NUMERIC(78,0) components. Products
  // of validated components are bounded to 156 digits (157 for their sum)
  // before reduction.
  nonnegative(result.numerator, NUMERIC_MAX);
  nonnegative(result.denominator, NUMERIC_MAX);
  return result;
}

function multiply(a: MeteringRational, b: MeteringRational): MeteringRational {
  const left = gcd(a.numerator, b.denominator);
  const right = gcd(b.numerator, a.denominator);
  return fraction(
    (a.numerator / left) * (b.numerator / right),
    (a.denominator / right) * (b.denominator / left),
  );
}

function add(a: MeteringRational, b: MeteringRational): MeteringRational {
  const divisor = gcd(a.denominator, b.denominator);
  return fraction(
    a.numerator * (b.denominator / divisor) +
      b.numerator * (a.denominator / divisor),
    (a.denominator / divisor) * b.denominator,
  );
}

/** Pure arithmetic only: no evidence authentication, tariff selection, quote
 * authority, wallet write or failure-charging decision. The caller supplies an
 * owner-validated profile and immutable rates for one actual attempt. Every
 * declared bucket needs known usage and an explicit rate (including zero).
 */
export function priceMeteredAttempt(
  input: MeteringPricingInput,
): MeteringPricingResult {
  shape(input, ["profile", "usage", "rates", "multiplier", "conversion"]);
  shape(input.profile, ["version", "buckets"]);
  identifier(input.profile.version);
  collection(input.profile.buckets);
  collection(input.usage);
  collection(input.rates);
  shape(input.conversion, ["currencyCode", "creditMicrosPerMinor"]);
  currency(input.conversion.currencyCode);
  validateRatio(input.multiplier, true);
  validateRatio(input.conversion.creditMicrosPerMinor, true);

  const buckets = new Map<
    string,
    MeteringPricingInput["profile"]["buckets"][number]
  >();
  for (const bucket of input.profile.buckets) {
    shape(bucket, ["key", "unit", "includedIn"]);
    identifier(bucket.key);
    identifier(bucket.unit);
    if (bucket.includedIn !== null) identifier(bucket.includedIn);
    if (buckets.has(bucket.key))
      throw new TypeError("Duplicate metering profile bucket");
    buckets.set(bucket.key, bucket);
  }
  for (const bucket of buckets.values()) {
    const seen = new Set([bucket.key]);
    let parentKey = bucket.includedIn;
    while (parentKey !== null) {
      const parent = buckets.get(parentKey);
      if (!parent || seen.has(parentKey) || parent.unit !== bucket.unit)
        throw new TypeError("Invalid metering inclusion graph");
      seen.add(parentKey);
      parentKey = parent.includedIn;
    }
  }

  const quantities = new Map<string, bigint>();
  for (const usage of input.usage) {
    shape(usage, ["bucket", "unit", "quantity"]);
    identifier(usage.bucket);
    identifier(usage.unit);
    nonnegative(usage.quantity, INT64_MAX);
    const bucket = buckets.get(usage.bucket);
    if (!bucket || bucket.unit !== usage.unit || quantities.has(usage.bucket))
      throw new TypeError("Unknown, duplicate or mismatched metering usage");
    // null remains distinct from zero, also in the compile-time narrowing.
    if (usage.quantity === null) throw new TypeError("Unknown metering usage");
    quantities.set(usage.bucket, usage.quantity);
  }

  const rates = new Map<string, MeteringRational>();
  for (const rate of input.rates) {
    shape(rate, ["bucket", "unit", "currencyCode", "minorPerUnit"]);
    identifier(rate.bucket);
    identifier(rate.unit);
    currency(rate.currencyCode);
    validateRatio(rate.minorPerUnit, false);
    const bucket = buckets.get(rate.bucket);
    if (
      !bucket ||
      bucket.unit !== rate.unit ||
      rates.has(rate.bucket) ||
      rate.currencyCode !== input.conversion.currencyCode
    )
      throw new TypeError("Unknown, duplicate or mismatched metering rate");
    rates.set(
      rate.bucket,
      fraction(rate.minorPerUnit.numerator, rate.minorPerUnit.denominator),
    );
  }
  if (quantities.size !== buckets.size || rates.size !== buckets.size)
    throw new TypeError("Incomplete metering usage or rate coverage");

  const includedTotals = new Map<string, bigint>();
  for (const bucket of buckets.values()) {
    const quantity = quantities.get(bucket.key);
    if (quantity === undefined) throw new TypeError("Missing metering usage");
    if (bucket.includedIn !== null)
      includedTotals.set(
        bucket.includedIn,
        (includedTotals.get(bucket.includedIn) ?? 0n) + quantity,
      );
  }

  const normalizedUsage: {
    bucket: string;
    unit: string;
    quantity: bigint;
  }[] = [];
  let procurementCostMinor: MeteringRational = {
    numerator: 0n,
    denominator: 1n,
  };
  // Stable order makes the bounded exact intermediate checks deterministic.
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key);
    const total = quantities.get(key);
    const rate = rates.get(key);
    if (!bucket || total === undefined || !rate)
      throw new TypeError("Incomplete metering pricing input");
    const quantity = total - (includedTotals.get(key) ?? 0n);
    nonnegative(quantity, INT64_MAX);
    normalizedUsage.push({ bucket: key, unit: bucket.unit, quantity });
    procurementCostMinor = add(
      procurementCostMinor,
      multiply({ numerator: quantity, denominator: 1n }, rate),
    );
  }
  const salesCostMinor = multiply(procurementCostMinor, input.multiplier);
  const unroundedCreditMicros = multiply(
    salesCostMinor,
    input.conversion.creditMicrosPerMinor,
  );
  const { numerator, denominator } = unroundedCreditMicros;
  const creditMicros =
    numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  nonnegative(creditMicros, INT64_MAX);
  return {
    profileVersion: input.profile.version,
    currencyCode: input.conversion.currencyCode,
    normalizedUsage,
    procurementCostMinor,
    salesCostMinor,
    unroundedCreditMicros,
    creditMicros,
    roundingVersion: "attempt-ceil-v1",
  };
}
