import { describe, expect, test } from "vitest";
import { parseMeteringPricingJson } from "../../src/modules/metering/metering-pricing-json.js";

describe("bounded pricing command JSON intent", () => {
  test("retains nested strings, range null, sibling names and JSON punctuation within strings", () => {
    const input = {
      a: [{ name: 'colon: and braces{} [] \\" quote' }, { name: "合法" }],
      range: { upper: null },
      object: { name: "0" },
    };
    expect(
      parseMeteringPricingJson(Buffer.from(JSON.stringify(input))),
    ).toEqual(input);
  });
  test.each([
    '{"budget":"1","budget":"2"}',
    '{"config":{"budget":"1","bu\\u0064get":"2"}}',
    '{"rows":[{"id":"a","id":"b"}]}',
    '{"__proto__":{},"__proto__":{}}',
    ' { "a": "1", }',
    "\ufeff{}",
    "",
  ])("rejects invalid or ambiguous JSON %#", (raw) => {
    expect(() => parseMeteringPricingJson(Buffer.from(raw))).toThrow();
  });
  test("bounds bytes, nesting and malformed UTF-8 before schema admission", () => {
    for (const input of [
      Buffer.alloc(1_048_577, 32),
      Buffer.from("[".repeat(13) + "null" + "]".repeat(13)),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]),
    ])
      expect(() => parseMeteringPricingJson(input)).toThrow();
  });
});
