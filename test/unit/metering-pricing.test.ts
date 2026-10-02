import { describe, expect, it } from "vitest";
import { priceMeteredAttempt } from "../../src/modules/metering/metering-pricing.js";
import type {
  MeteringPricingInput,
  MeteringRational,
} from "../../src/modules/metering/metering-pricing.types.js";

const INT64_MAX = 9_223_372_036_854_775_807n;
const NUMERIC_MAX = 10n ** 78n - 1n;
const rational = (numerator: bigint, denominator = 1n): MeteringRational => ({
  numerator,
  denominator,
});

// Every rate and conversion in this file is synthetic, not a provider price.
// XTS is only a fixture currency label. No production FX or gift is implied.
function fixture(): MeteringPricingInput {
  return {
    profile: {
      version: "synthetic-flat-v1",
      buckets: [{ key: "input", unit: "token", includedIn: null }],
    },
    usage: [{ bucket: "input", unit: "token", quantity: 1n }],
    rates: [
      {
        bucket: "input",
        unit: "token",
        currencyCode: "XTS",
        minorPerUnit: rational(1n),
      },
    ],
    multiplier: rational(1n),
    conversion: { currencyCode: "XTS", creditMicrosPerMinor: rational(1n) },
  };
}

function nestedFixture(): MeteringPricingInput {
  return {
    ...fixture(),
    profile: {
      version: "synthetic-inclusive-v1",
      buckets: [
        { key: "input", unit: "token", includedIn: null },
        { key: "cached", unit: "token", includedIn: "input" },
        { key: "cache_write", unit: "token", includedIn: "input" },
        { key: "output", unit: "token", includedIn: null },
        { key: "reasoning", unit: "token", includedIn: "output" },
      ],
    },
    usage: [
      { bucket: "input", unit: "token", quantity: 100n },
      { bucket: "cached", unit: "token", quantity: 20n },
      { bucket: "cache_write", unit: "token", quantity: 10n },
      { bucket: "output", unit: "token", quantity: 50n },
      { bucket: "reasoning", unit: "token", quantity: 15n },
    ],
    rates: [
      {
        bucket: "input",
        unit: "token",
        currencyCode: "XTS",
        minorPerUnit: rational(1n),
      },
      {
        bucket: "cached",
        unit: "token",
        currencyCode: "XTS",
        minorPerUnit: rational(1n, 2n),
      },
      {
        bucket: "cache_write",
        unit: "token",
        currencyCode: "XTS",
        minorPerUnit: rational(2n),
      },
      {
        bucket: "output",
        unit: "token",
        currencyCode: "XTS",
        minorPerUnit: rational(2n),
      },
      {
        bucket: "reasoning",
        unit: "token",
        currencyCode: "XTS",
        minorPerUnit: rational(3n),
      },
    ],
    multiplier: rational(7n, 5n),
    conversion: { currencyCode: "XTS", creditMicrosPerMinor: rational(5n, 2n) },
  };
}

function withQuantity(quantity: bigint | null): MeteringPricingInput {
  return {
    ...fixture(),
    usage: [{ bucket: "input", unit: "token", quantity }],
  };
}

// Mutate only a fresh fixture to exercise runtime failure at this internal seam.
function corrupt(
  path: readonly (string | number)[],
  value: unknown,
): MeteringPricingInput {
  const input = structuredClone(fixture());
  let target: unknown = input;
  for (const key of path.slice(0, -1)) {
    if (target === null || typeof target !== "object")
      throw new Error("Bad test path");
    target = Reflect.get(target, key);
  }
  const key = path.at(-1);
  if (target === null || typeof target !== "object" || key === undefined)
    throw new Error("Bad test target");
  Reflect.set(target, key, value);
  return input;
}

describe("Billing pure metering pricing (synthetic rates only)", () => {
  it("legal zero control is exactly zero, not a minimum charge", () => {
    expect(priceMeteredAttempt(withQuantity(0n))).toEqual({
      profileVersion: "synthetic-flat-v1",
      currencyCode: "XTS",
      normalizedUsage: [{ bucket: "input", unit: "token", quantity: 0n }],
      procurementCostMinor: rational(0n),
      salesCostMinor: rational(0n),
      unroundedCreditMicros: rational(0n),
      creditMicros: 0n,
      roundingVersion: "attempt-ceil-v1",
    });
  });

  it("prices the legal one-unit control", () => {
    const result = priceMeteredAttempt(fixture());
    expect(result.procurementCostMinor).toEqual(rational(1n));
    expect(result.creditMicros).toBe(1n);
  });

  it("subtracts included cache/reasoning buckets exactly once and applies 7/5", () => {
    const result = priceMeteredAttempt(nestedFixture());
    expect(result.normalizedUsage).toEqual([
      { bucket: "cache_write", unit: "token", quantity: 10n },
      { bucket: "cached", unit: "token", quantity: 20n },
      { bucket: "input", unit: "token", quantity: 70n },
      { bucket: "output", unit: "token", quantity: 35n },
      { bucket: "reasoning", unit: "token", quantity: 15n },
    ]);
    expect(result.procurementCostMinor).toEqual(rational(215n));
    expect(result.salesCostMinor).toEqual(rational(301n));
    expect(result.unroundedCreditMicros).toEqual(rational(1505n, 2n));
    expect(result.creditMicros).toBe(753n);
  });

  it("subtracts direct child totals, not grandchildren twice", () => {
    const input = nestedFixture();
    const profile = {
      ...input.profile,
      buckets: input.profile.buckets.map((bucket) =>
        bucket.key === "cache_write"
          ? { ...bucket, includedIn: "cached" }
          : bucket,
      ),
    };
    const result = priceMeteredAttempt({ ...input, profile });
    expect(
      result.normalizedUsage.find((bucket) => bucket.bucket === "input")
        ?.quantity,
    ).toBe(80n);
    expect(
      result.normalizedUsage.find((bucket) => bucket.bucket === "cached")
        ?.quantity,
    ).toBe(10n);
    expect(result.procurementCostMinor).toEqual(rational(220n));
  });

  it("sums fractional categories before the single final ceil", () => {
    const input = fixture();
    const result = priceMeteredAttempt({
      ...input,
      profile: {
        version: "synthetic-disjoint-v1",
        buckets: [
          { key: "a", unit: "token", includedIn: null },
          { key: "b", unit: "token", includedIn: null },
        ],
      },
      usage: ["a", "b"].map((bucket) => ({
        bucket,
        unit: "token",
        quantity: 1n,
      })),
      rates: ["a", "b"].map((bucket) => ({
        bucket,
        unit: "token",
        currencyCode: "XTS",
        minorPerUnit: rational(1n, 3n),
      })),
      multiplier: rational(7n, 5n),
      conversion: {
        currencyCode: "XTS",
        creditMicrosPerMinor: rational(5n, 2n),
      },
    });
    expect(result.procurementCostMinor).toEqual(rational(2n, 3n));
    expect(result.salesCostMinor).toEqual(rational(14n, 15n));
    expect(result.unroundedCreditMicros).toEqual(rational(7n, 3n));
    expect(result.creditMicros).toBe(3n); // Per-bucket ceil would incorrectly charge 4.
  });

  it("does not treat 7/5 markup as a margin or a fixed default", () => {
    const input = withQuantity(10n);
    expect(
      priceMeteredAttempt({ ...input, multiplier: rational(7n, 5n) })
        .creditMicros,
    ).toBe(14n);
    expect(
      priceMeteredAttempt({ ...input, multiplier: rational(3n, 2n) })
        .creditMicros,
    ).toBe(15n);
  });

  it("honors explicit free rates even for nonzero observed usage", () => {
    const input = fixture();
    expect(
      priceMeteredAttempt({
        ...input,
        rates: input.rates.map((rate) => ({
          ...rate,
          minorPerUnit: rational(0n, 5n),
        })),
      }).creditMicros,
    ).toBe(0n);
  });

  it.each([9_007_199_254_740_993n, INT64_MAX])(
    "preserves bigint %s without number conversion",
    (quantity) => {
      expect(priceMeteredAttempt(withQuantity(quantity)).creditMicros).toBe(
        quantity,
      );
    },
  );

  it("canonicalizes fractions and cross-cancels large products", () => {
    const input = fixture();
    const result = priceMeteredAttempt({
      ...input,
      rates: input.rates.map((rate) => ({
        ...rate,
        minorPerUnit: rational(NUMERIC_MAX, 2n),
      })),
      multiplier: rational(2n, NUMERIC_MAX),
      conversion: {
        currencyCode: "XTS",
        creditMicrosPerMinor: rational(14n, 10n),
      },
    });
    expect(result.salesCostMinor).toEqual(rational(1n));
    expect(result.unroundedCreditMicros).toEqual(rational(7n, 5n));
    expect(result.creditMicros).toBe(2n);
  });

  it("sorts deterministically without mutating or aliasing input", () => {
    const input = nestedFixture();
    const before = structuredClone(input);
    const reverse = {
      ...input,
      profile: {
        ...input.profile,
        buckets: [...input.profile.buckets].reverse(),
      },
      usage: [...input.usage].reverse(),
      rates: [...input.rates].reverse(),
    };
    expect(priceMeteredAttempt(input)).toEqual(priceMeteredAttempt(reverse));
    const result = priceMeteredAttempt(input);
    expect(input).toEqual(before);
    expect(result.procurementCostMinor).not.toBe(input.rates[0]?.minorPerUnit);
    Object.freeze(input);
    expect(priceMeteredAttempt(input).creditMicros).toBe(753n);
  });

  it("supports disjoint units but never converts between them implicitly", () => {
    const input = fixture();
    expect(
      priceMeteredAttempt({
        ...input,
        profile: {
          version: "synthetic-mixed-v1",
          buckets: [
            ...input.profile.buckets,
            { key: "audio", unit: "millisecond", includedIn: null },
          ],
        },
        usage: [
          ...input.usage,
          { bucket: "audio", unit: "millisecond", quantity: 1000n },
        ],
        rates: [
          ...input.rates,
          {
            bucket: "audio",
            unit: "millisecond",
            currencyCode: "XTS",
            minorPerUnit: rational(1n, 1000n),
          },
        ],
      }).creditMicros,
    ).toBe(2n);
  });

  it.each([
    ["unknown usage", ["usage", 0, "quantity"], null],
    ["missing quantity", ["usage", 0, "quantity"], undefined],
    ["number quantity", ["usage", 0, "quantity"], 1],
    ["negative quantity", ["usage", 0, "quantity"], -1n],
    ["quantity overflow", ["usage", 0, "quantity"], INT64_MAX + 1n],
    ["empty unit", ["usage", 0, "unit"], ""],
    ["missing unit", ["rates", 0, "unit"], undefined],
    ["mismatched unit", ["rates", 0, "unit"], "image"],
    ["usage unit mismatch", ["usage", 0, "unit"], "image"],
    ["unknown bucket", ["usage", 0, "bucket"], "extra"],
    ["missing usage", ["usage"], []],
    ["missing rates", ["rates"], []],
    ["missing profile", ["profile"], undefined],
    ["missing version", ["profile", "version"], ""],
    ["empty profile", ["profile", "buckets"], []],
    ["self inclusion", ["profile", "buckets", 0, "includedIn"], "input"],
    ["missing parent", ["profile", "buckets", 0, "includedIn"], "absent"],
    ["missing conversion", ["conversion"], undefined],
    [
      "missing conversion rate",
      ["conversion", "creditMicrosPerMinor"],
      undefined,
    ],
    ["mixed currency", ["rates", 0, "currencyCode"], "USD"],
    ["missing currency", ["conversion", "currencyCode"], ""],
    ["invalid currency", ["conversion", "currencyCode"], "xts"],
    ["zero multiplier", ["multiplier", "numerator"], 0n],
    ["negative multiplier", ["multiplier", "numerator"], -1n],
    ["missing multiplier", ["multiplier"], undefined],
    [
      "zero conversion",
      ["conversion", "creditMicrosPerMinor", "numerator"],
      0n,
    ],
    ["negative rate", ["rates", 0, "minorPerUnit", "numerator"], -1n],
    ["zero denominator", ["rates", 0, "minorPerUnit", "denominator"], 0n],
    ["negative denominator", ["multiplier", "denominator"], -1n],
    ["number ratio", ["multiplier", "numerator"], 1.4],
    [
      "numeric component overflow",
      ["rates", 0, "minorPerUnit", "numerator"],
      NUMERIC_MAX + 1n,
    ],
    ["denominator overflow", ["multiplier", "denominator"], NUMERIC_MAX + 1n],
    ["caller final amount", ["actualMicros"], 1n],
    ["generic receipt", ["receipt"], { total: 0 }],
    ["unknown rate field", ["rates", 0, "default"], true],
  ] as const)("fails closed: %s", (_name, path, value) => {
    expect(() => priceMeteredAttempt(corrupt(path, value))).toThrow();
  });

  it("requires complete units/rates/conversion even when quantity is zero", () => {
    const input = corrupt(["conversion"], undefined);
    expect(() =>
      priceMeteredAttempt({ ...input, usage: withQuantity(0n).usage }),
    ).toThrow();
    expect(() =>
      priceMeteredAttempt({ ...withQuantity(0n), rates: [] }),
    ).toThrow();
  });

  it.each(["usage", "rates"] as const)(
    "rejects duplicate %s entries",
    (key) => {
      const input = fixture();
      expect(() =>
        priceMeteredAttempt({
          ...input,
          [key]: [...input[key], ...input[key]],
        }),
      ).toThrow();
    },
  );

  it("rejects duplicate profile keys", () => {
    const input = fixture();
    expect(() =>
      priceMeteredAttempt({
        ...input,
        profile: {
          ...input.profile,
          buckets: [...input.profile.buckets, ...input.profile.buckets],
        },
      }),
    ).toThrow();
  });

  it("rejects sibling totals above their parent", () => {
    const input = nestedFixture();
    expect(() =>
      priceMeteredAttempt({
        ...input,
        usage: input.usage.map((item) =>
          item.bucket === "input" ? { ...item, quantity: 29n } : item,
        ),
      }),
    ).toThrow();
  });

  it("rejects inclusion cycles", () => {
    const input = nestedFixture();
    expect(() =>
      priceMeteredAttempt({
        ...input,
        profile: {
          ...input.profile,
          buckets: input.profile.buckets.map((item) =>
            item.key === "input" ? { ...item, includedIn: "cached" } : item,
          ),
        },
      }),
    ).toThrow();
  });

  it("rejects incompatible units in an inclusion edge", () => {
    const input = nestedFixture();
    expect(() =>
      priceMeteredAttempt({
        ...input,
        profile: {
          ...input.profile,
          buckets: input.profile.buckets.map((item) =>
            item.key === "cached" ? { ...item, unit: "image" } : item,
          ),
        },
        usage: input.usage.map((item) =>
          item.bucket === "cached" ? { ...item, unit: "image" } : item,
        ),
        rates: input.rates.map((item) =>
          item.bucket === "cached" ? { ...item, unit: "image" } : item,
        ),
      }),
    ).toThrow();
  });

  it("rejects final int64 overflow including fractional ceil across the boundary", () => {
    expect(() =>
      priceMeteredAttempt({
        ...withQuantity(INT64_MAX),
        multiplier: rational(2n),
      }),
    ).toThrow(RangeError);
    const input = fixture();
    expect(() =>
      priceMeteredAttempt({
        ...input,
        rates: input.rates.map((rate) => ({
          ...rate,
          minorPerUnit: rational(INT64_MAX * 2n + 1n, 2n),
        })),
      }),
    ).toThrow(RangeError);
  });

  it("rejects exact intermediate storage overflow even if a later factor could shrink it", () => {
    const input = withQuantity(2n);
    expect(() =>
      priceMeteredAttempt({
        ...input,
        rates: input.rates.map((rate) => ({
          ...rate,
          minorPerUnit: rational(NUMERIC_MAX),
        })),
        multiplier: rational(1n, NUMERIC_MAX),
      }),
    ).toThrow(RangeError);
  });

  it("charges one micro for a verified positive fraction, without rounding the cost to zero", () => {
    const input = fixture();
    const result = priceMeteredAttempt({
      ...input,
      rates: input.rates.map((rate) => ({
        ...rate,
        minorPerUnit: rational(1n, NUMERIC_MAX),
      })),
    });
    expect(result.procurementCostMinor).toEqual(rational(1n, NUMERIC_MAX));
    expect(result.creditMicros).toBe(1n);
  });

  it("allows children to exactly exhaust a parent and still requires the parent's explicit rate", () => {
    const input = nestedFixture();
    const exact = {
      ...input,
      usage: input.usage.map((item) =>
        item.bucket === "input" ? { ...item, quantity: 30n } : item,
      ),
    };
    expect(
      priceMeteredAttempt(exact).normalizedUsage.find(
        (item) => item.bucket === "input",
      )?.quantity,
    ).toBe(0n);
    expect(() =>
      priceMeteredAttempt({
        ...exact,
        rates: exact.rates.filter((item) => item.bucket !== "input"),
      }),
    ).toThrow(TypeError);
  });

  it("allows at most 64 declared buckets with exact complete coverage", () => {
    const make = (count: number): MeteringPricingInput => {
      const keys = Array.from({ length: count }, (_, i) => `bucket_${i}`);
      return {
        ...fixture(),
        profile: {
          version: "synthetic-bound-v1",
          buckets: keys.map((key) => ({
            key,
            unit: "token",
            includedIn: null,
          })),
        },
        usage: keys.map((bucket) => ({ bucket, unit: "token", quantity: 1n })),
        rates: keys.map((bucket) => ({
          bucket,
          unit: "token",
          currencyCode: "XTS",
          minorPerUnit: rational(1n),
        })),
      };
    };
    expect(priceMeteredAttempt(make(64)).creditMicros).toBe(64n);
    expect(() => priceMeteredAttempt(make(65))).toThrow(RangeError);
  });

  it("rejects exact cost denominator growth beyond the storage budget", () => {
    const input = nestedFixture();
    expect(() =>
      priceMeteredAttempt({
        ...input,
        rates: input.rates.map((rate, i) => ({
          ...rate,
          minorPerUnit: rational(1n, NUMERIC_MAX - BigInt(i)),
        })),
      }),
    ).toThrow(RangeError);
  });

  it("matches an independent common-denominator oracle over synthetic rational inputs", () => {
    for (let q = 0n; q < 17n; q++) {
      for (let rateDenominator = 1n; rateDenominator < 12n; rateDenominator++) {
        const input = withQuantity(q);
        const result = priceMeteredAttempt({
          ...input,
          rates: input.rates.map((rate) => ({
            ...rate,
            minorPerUnit: rational(3n, rateDenominator),
          })),
          multiplier: rational(7n, 5n),
          conversion: {
            currencyCode: "XTS",
            creditMicrosPerMinor: rational(11n, 13n),
          },
        });
        const numerator = q * 3n * 7n * 11n;
        const denominator = rateDenominator * 5n * 13n;
        expect(result.creditMicros).toBe(
          (numerator + denominator - 1n) / denominator,
        );
        expect(result.unroundedCreditMicros.numerator * denominator).toBe(
          numerator * result.unroundedCreditMicros.denominator,
        );
      }
    }
  });

  it("does not mutate deeply frozen inputs and has no shared result aliases", () => {
    const input = nestedFixture();
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(input);
    const result = priceMeteredAttempt(input);
    Reflect.set(result.procurementCostMinor, "numerator", 0n);
    expect(priceMeteredAttempt(input).procurementCostMinor).toEqual(
      rational(215n),
    );
    expect(priceMeteredAttempt(input).creditMicros).toBe(753n);
  });

  it.each([
    ["rates is not an array", ["rates"], {}],
    ["null usage item", ["usage", 0], null],
    ["null rational", ["rates", 0, "minorPerUnit"], null],
    [
      "undefined profile parent",
      ["profile", "buckets", 0, "includedIn"],
      undefined,
    ],
    ["empty profile unit", ["profile", "buckets", 0, "unit"], ""],
    [
      "negative conversion denominator",
      ["conversion", "creditMicrosPerMinor", "denominator"],
      -1n,
    ],
    ["unexpected rational field", ["multiplier", "float"], 1.4],
    ["unsafe bucket name", ["profile", "buckets", 0, "key"], "input\u0000"],
  ] as const)("rejects malformed internal input: %s", (_name, path, value) => {
    expect(() => priceMeteredAttempt(corrupt(path, value))).toThrow();
  });

  it("rejects absent own fields and unexpected symbol keys", () => {
    const input = structuredClone(fixture());
    Reflect.deleteProperty(input.conversion, "creditMicrosPerMinor");
    expect(() => priceMeteredAttempt(input)).toThrow(TypeError);
    const extra = fixture();
    Reflect.set(extra, Symbol("unexpected"), 0n);
    expect(() => priceMeteredAttempt(extra)).toThrow(TypeError);
  });
});
