import { describe, expect, it } from "vitest";
import {
  billingHeaderCount,
  decodeBillingIdentityHeader,
  encodeBillingIdentityHeader,
} from "../../src/infrastructure/auth/billing-identity-header.js";
import type { BillingIdentityKind } from "../../src/infrastructure/auth/billing-auth.types.js";

const kinds: readonly BillingIdentityKind[] = ["tenant", "subject"];
const wire = (value: string) =>
  "u1." + Buffer.from(value, "utf8").toString("base64url");
describe.each(kinds)("personal-identity-u1 %s", (kind) => {
  const max = kind === "tenant" ? 191 : 255;
  it.each([
    "identity-a",
    "日本語",
    "😀".repeat(max),
    "\uFEFFidentity-a",
    "identity-a\uFEFF",
    " identity-a ",
    "e\u0301",
    "é",
    "\tidentity-a",
  ])("preserves legal identity %# and exact UTF-8", (identity) => {
    const encoded = encodeBillingIdentityHeader(identity, kind);
    expect(encoded).toBe(wire(identity));
    const decoded = decodeBillingIdentityHeader(encoded, kind);
    expect(decoded).toBe(identity);
    expect([...decoded]).toEqual([...identity]);
    expect(Buffer.from(decoded, "utf8")).toEqual(Buffer.from(identity, "utf8"));
    expect(encodeBillingIdentityHeader(decoded, kind)).toBe(encoded);
    if (identity.startsWith("\uFEFF"))
      expect(Buffer.from(decoded).subarray(0, 3)).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      );
  });
  it("supports the exact maximum four-byte identity and wire budget", () => {
    const identity = "😀".repeat(max);
    const encoded = encodeBillingIdentityHeader(identity, kind);
    expect(encoded.length).toBe(kind === "tenant" ? 1022 : 1363);
    expect(decodeBillingIdentityHeader(encoded, kind)).toBe(identity);
  });
  it.each([
    "",
    "x\u0000y",
    "\uD800",
    "\uDC00",
    "x".repeat(max + 1),
    "😀".repeat(max + 1),
  ])(
    "rejects invalid semantic identity %# after a legal control",
    (identity) => {
      expect(
        decodeBillingIdentityHeader(
          encodeBillingIdentityHeader("identity-a", kind),
          kind,
        ),
      ).toBe("identity-a");
      expect(() => encodeBillingIdentityHeader(identity, kind)).toThrow(
        TypeError,
      );
      expect(() =>
        decodeBillingIdentityHeader(
          identity === "\uD800"
            ? "u1.7aCA"
            : identity === "\uDC00"
              ? "u1.7bCA"
              : wire(identity),
          kind,
        ),
      ).toThrow(TypeError);
    },
  );
  it.each([
    "identity-a",
    "%69dentity-a",
    "v1.aQ",
    "u1.",
    "u1.aQ=",
    "u1.aQ==",
    "u1. aQ",
    "u1.aQ ",
    "u1.aQ, u1.aQ",
    "u1.aR",
    "u1.a+",
    "u1.a/",
    "u1.A",
    "u1._w",
    "u1.wK8",
    "u1.7aCA",
  ])(
    "rejects noncanonical/malformed wire %# after a legal control",
    (value) => {
      expect(decodeBillingIdentityHeader(wire("i"), kind)).toBe("i");
      expect(() => decodeBillingIdentityHeader(value, kind)).toThrow(TypeError);
    },
  );
  it.each([
    undefined,
    null,
    123,
    [wire("identity-a")],
    { value: wire("identity-a") },
  ])("rejects non-single string value %#", (value) => {
    expect(decodeBillingIdentityHeader(wire("identity-a"), kind)).toBe(
      "identity-a",
    );
    expect(() => decodeBillingIdentityHeader(value, kind)).toThrow(TypeError);
  });
});
it("counts raw header occurrences case-insensitively without truthy selection", () => {
  expect(
    billingHeaderCount(["X-Kokoro-Subject", "u1.aQ"], "x-kokoro-subject"),
  ).toBe(1);
  expect(
    billingHeaderCount(
      ["x-kokoro-subject", "", "X-Kokoro-Subject", "u1.aQ"],
      "x-kokoro-subject",
    ),
  ).toBe(2);
});
