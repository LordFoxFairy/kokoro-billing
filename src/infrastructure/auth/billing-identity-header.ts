import type { BillingIdentityKind } from "./billing-auth.types.js";

export function assertBillingIdentity(
  value: unknown,
  kind: BillingIdentityKind,
): asserts value is string {
  const maximum = kind === "tenant" ? 191 : 255;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > maximum ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point === 0 || (point >= 0xd800 && point <= 0xdfff);
    })
  )
    throw new TypeError("Invalid Billing identity");
}
export function encodeBillingIdentityHeader(
  value: unknown,
  kind: BillingIdentityKind,
): string {
  assertBillingIdentity(value, kind);
  return "u1." + Buffer.from(value, "utf8").toString("base64url");
}
export function decodeBillingIdentityHeader(
  wire: unknown,
  kind: BillingIdentityKind,
): string {
  const maximum = kind === "tenant" ? 1022 : 1363;
  if (
    typeof wire !== "string" ||
    wire.length < 5 ||
    wire.length > maximum ||
    !/^u1\.[A-Za-z0-9_-]+$/u.test(wire)
  )
    throw new TypeError("Invalid Billing identity header");
  const body = wire.slice(3);
  const bytes = Buffer.from(body, "base64url");
  if (bytes.toString("base64url") !== body)
    throw new TypeError("Noncanonical Billing identity header");
  const value = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  assertBillingIdentity(value, kind);
  if (!Buffer.from(value, "utf8").equals(bytes))
    throw new TypeError("Invalid Billing identity UTF-8");
  return value;
}
export function billingHeaderCount(
  rawHeaders: readonly string[],
  name: string,
): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count++;
  }
  return count;
}
