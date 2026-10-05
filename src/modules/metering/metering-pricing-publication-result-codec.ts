import type { ResultCodec } from "../../database/command-receipt.types.js";

export type MeteringPricingPublicationResultV1<
  Kind extends "rate" | "policy" = "rate",
> = Readonly<{
  schemaVersion: 1;
  kind: Kind;
  tenantId: string;
  revision: string;
  contentDigest: string;
  publishedAt: string;
  effectiveFrom: string;
}>;

const fields = [
  "schemaVersion",
  "kind",
  "tenantId",
  "revision",
  "contentDigest",
  "publishedAt",
  "effectiveFrom",
] as const;
const instant =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9]\.[0-9]{3}Z$/u;

function decode<Kind extends "rate" | "policy">(
  value: unknown,
  kind: Kind,
): MeteringPricingPublicationResultV1<Kind> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    throw new TypeError("Invalid metering publication result");
  const record = value as Record<string, unknown>;
  if (
    fields.some((field) => !Object.hasOwn(record, field)) ||
    record.schemaVersion !== 1 ||
    record.kind !== kind ||
    typeof record.tenantId !== "string" ||
    record.tenantId.length === 0 ||
    typeof record.revision !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(record.revision) ||
    BigInt(record.revision) > 9_223_372_036_854_775_807n ||
    typeof record.contentDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.contentDigest) ||
    typeof record.publishedAt !== "string" ||
    !instant.test(record.publishedAt) ||
    new Date(record.publishedAt).toISOString() !== record.publishedAt ||
    typeof record.effectiveFrom !== "string" ||
    !instant.test(record.effectiveFrom) ||
    new Date(record.effectiveFrom).toISOString() !== record.effectiveFrom
  )
    throw new TypeError("Invalid metering publication result");
  return {
    schemaVersion: 1,
    kind,
    tenantId: record.tenantId,
    revision: record.revision,
    contentDigest: record.contentDigest,
    publishedAt: record.publishedAt,
    effectiveFrom: record.effectiveFrom,
  };
}

export function meteringPricingPublicationResultCodec<
  Kind extends "rate" | "policy",
>(kind: Kind): ResultCodec<MeteringPricingPublicationResultV1<Kind>> {
  return Object.freeze({
    schemaVersion: 1,
    encode: (value: MeteringPricingPublicationResultV1<Kind>) =>
      decode(value, kind),
    decode: (value: unknown) => decode(value, kind),
  });
}
