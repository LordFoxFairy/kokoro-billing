import { z } from "zod";
import { encodeModelAdmissionPricing } from "./model-admission-codec.js";
import { ModelAdmissionError } from "./model-admission.error.js";
import { parseMeteringPricingJson } from "./metering-pricing-json.js";
import {
  parseMeteringModelRevision,
  parseMeteringRevisionRate,
  parseMeteringRevisionRates,
  parseMeteringRevisionRational,
} from "./metering-pricing-revision-codec.js";
import {
  currentMeteringProfileRef,
  currentMeteringFailurePolicyRef,
} from "./metering-policy-artifact.js";
import type { MeteringFrozenPricing } from "./metering-pricing-selection.types.js";
import type { MeteringModelRevisionReference } from "./metering-pricing-revision.types.js";
import { freezeAgentUsageFacts } from "./agent-usage-evidence.js";
const text = z
  .string()
  .min(1)
  .max(512)
  .refine((s) =>
    [...s].every((c) => {
      const p = c.codePointAt(0) ?? 0;
      return p >= 32 && p !== 127 && (p < 0xd800 || p > 0xdfff);
    }),
  );
const digest = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);
const uuid = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]+$/u);
const ordinal = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((s) => BigInt(s) <= 9223372036854775807n);
const instant = z
  .string()
  .datetime()
  .refine((s) => !s.startsWith("0000-") && new Date(s).toISOString() === s);
const reference = z.object({ version: text, artifactDigest: digest }).strict();
const binding = z
  .object({
    providerRef: text,
    environment: text,
    pricingAccountRef: text,
    modelRef: text,
    modelVersion: text,
  })
  .strict();
const schema = z
  .object({
    tenantId: text,
    modelRevision: z.unknown().transform(parseMeteringModelRevision),
    binding,
    dbNow: instant,
    revisionId: uuid,
    revision: ordinal,
    effectiveFrom: instant,
    contentDigest: digest,
    profileRef: reference,
    currencyCode: z.string().regex(/^[A-Z]{3}$/u),
    rates: z
      .array(z.unknown().transform(parseMeteringRevisionRate))
      .min(1)
      .max(64),
    policy: z
      .object({
        revisionId: uuid,
        revision: ordinal,
        contentDigest: digest,
        effectiveFrom: instant,
        multiplier: z
          .unknown()
          .transform((v) => parseMeteringRevisionRational(v, true)),
        creditMicrosPerMinor: z
          .unknown()
          .transform((v) => parseMeteringRevisionRational(v, true)),
        maxAttemptCredits: z
          .string()
          .regex(/^[1-9][0-9]{0,12}$/u)
          .refine((s) => BigInt(s) <= 9223372036854n),
        roundingVersion: z.literal("attempt-credit-ceil-v2"),
        failurePolicyRef: reference,
      })
      .strict(),
  })
  .strict();
/** The snapshot is a filtered tariff subset, not the full published revision draft. */
export function decodeFrozenModelPricing(
  raw: string,
  digest: string,
  expected: Readonly<{
    tenantId: string;
    modelRevision: MeteringModelRevisionReference;
    budgetCredits: string;
  }>,
): MeteringFrozenPricing {
  try {
    const value = schema.parse(
      parseMeteringPricingJson(Buffer.from(raw, "utf8")),
    );
    parseMeteringRevisionRates(value.rates);
    const encoded = encodeModelAdmissionPricing(value),
      failure = currentMeteringFailurePolicyRef();
    if (
      encoded.json !== raw ||
      encoded.digest !== digest ||
      value.tenantId !== expected.tenantId ||
      value.modelRevision.id !== expected.modelRevision.id ||
      value.modelRevision.contentDigest !==
        expected.modelRevision.contentDigest ||
      value.policy.maxAttemptCredits !== expected.budgetCredits ||
      value.effectiveFrom > value.dbNow ||
      value.policy.effectiveFrom > value.dbNow ||
      value.profileRef.version !== currentMeteringProfileRef.version ||
      value.profileRef.artifactDigest !==
        currentMeteringProfileRef.artifactDigest ||
      value.policy.failurePolicyRef.version !== failure.version ||
      value.policy.failurePolicyRef.artifactDigest !== failure.artifactDigest
    )
      throw new Error();
    for (const row of value.rates) {
      if (
        row.modelRevision.id !== value.modelRevision.id ||
        row.modelRevision.contentDigest !== value.modelRevision.contentDigest ||
        row.currencyCode !== value.currencyCode
      )
        throw new Error();
      for (const key of [
        "providerRef",
        "environment",
        "pricingAccountRef",
        "modelRef",
        "modelVersion",
      ] as const)
        if (row[key] !== value.binding[key]) throw new Error();
    }
    return freezeAgentUsageFacts(value);
  } catch {
    throw new ModelAdmissionError("CORRUPT");
  }
}
