import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonDigest,
} from "../../src/infrastructure/postgres/canonical-json.js";

describe("canonical JSON command payloads", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const first = {
      quote: { key: "pro", details: { credits: "1000", currency: "USD" } },
      tiers: [
        { name: "first", amount: 1 },
        { amount: 2, name: "second" },
      ],
    };
    const reordered = {
      tiers: [
        { amount: 1, name: "first" },
        { name: "second", amount: 2 },
      ],
      quote: { details: { currency: "USD", credits: "1000" }, key: "pro" },
    };

    expect(canonicalJson(reordered)).toBe(canonicalJson(first));
    expect(canonicalJsonDigest(reordered)).toBe(canonicalJsonDigest(first));
    expect(canonicalJsonDigest({ values: ["a", "b"] })).not.toBe(
      canonicalJsonDigest({ values: ["b", "a"] }),
    );
  });

  it.each([
    { name: "undefined", value: { invalid: undefined } },
    { name: "non-finite number", value: { invalid: Number.NaN } },
    { name: "bigint", value: { invalid: 1n } },
    {
      name: "date object",
      value: { invalid: new Date("2026-09-01T00:00:00Z") },
    },
  ])("rejects the non-JSON value $name", ({ value }) => {
    expect(() => canonicalJson(value)).toThrow(
      "billing.command_payload_not_json",
    );
  });
});
