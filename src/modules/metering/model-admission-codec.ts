import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CommandReceiptRequest,
  ResultCodec,
} from "../../database/command-receipt.types.js";
import { copyPreparedExpectation } from "./agent-prepared-call.js";
import type { ExpectedPreparedModelCall } from "./agent-prepared-call.js";
import type { MeteringFrozenPricing } from "./metering-pricing-selection.types.js";
import { ModelAdmissionError } from "./model-admission.error.js";
import type {
  ModelAdmissionCommand,
  ModelAdmissionContext,
  ModelAdmissionResult,
} from "./model-admission.types.js";
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) =>
      [...value].every((c) => {
        const p = c.codePointAt(0) ?? 0;
        return p >= 32 && p !== 127 && (p < 0xd800 || p > 0xdfff);
      }),
    );
const instant = z
  .string()
  .datetime()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const resultSchema = z
  .object({
    schemaVersion: z.literal(1),
    admissionId: uuid,
    tenantId: text(191),
    runId: text(512),
    attemptId: uuid,
    requestRef: text(512),
    holdId: uuid,
    budgetCredits: z
      .string()
      .regex(/^[1-9][0-9]{0,12}$/u)
      .refine((v) => BigInt(v) <= 9223372036854n),
    pricingSnapshotDigest: digest,
    createdAt: instant,
  })
  .strict();
export const modelAdmissionResultCodec: ResultCodec<ModelAdmissionResult> = {
  schemaVersion: 1,
  encode: (value) => resultSchema.parse(value),
  decode: (value) => Object.freeze(resultSchema.parse(value)),
};
export function modelAdmissionIntent(
  context: ModelAdmissionContext,
  command: ModelAdmissionCommand,
): Readonly<{
  context: ModelAdmissionContext;
  expected: ExpectedPreparedModelCall;
  receipt: CommandReceiptRequest;
}> {
  try {
    const ids = z
      .object({
        tenantId: text(191),
        actorId: text(255),
        requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,255}$/u),
      })
      .strict()
      .parse({
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestId: context.requestId,
      });
    if (!(context.signal instanceof AbortSignal)) throw new Error();
    const copied = structuredClone(command);
    const { idempotencyKey, ...binding } = copied;
    const key = z
      .string()
      .regex(/^[\x21-\x7e]{8,128}$/u)
      .parse(idempotencyKey);
    const expected = copyPreparedExpectation({
      ...binding,
      tenantId: ids.tenantId,
    });
    const payloadDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "kokoro.billing.model-admit:1",
          ids.tenantId,
          ids.actorId,
          expected.runId,
          expected.attemptId,
          expected.requestRef,
          expected.attemptBindingDigest,
          expected.plannedDigest,
          expected.finalRequestDigest,
        ]),
      )
      .digest("hex");
    return Object.freeze({
      context: Object.freeze({ ...ids, signal: context.signal }),
      expected,
      receipt: Object.freeze({
        tenantId: ids.tenantId,
        namespace: "admission",
        commandName: "model.admit",
        commandIdentity: expected.attemptId,
        idempotencyKey: key,
        requestSchemaVersion: 1,
        payloadDigest,
      }),
    });
  } catch {
    throw new ModelAdmissionError("INVALID");
  }
}
/** Only the validated, all-string/rational immutable tariff representation is accepted. */
export function encodeModelAdmissionPricing(
  pricing: MeteringFrozenPricing,
): Readonly<{ json: string; digest: string }> {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "string")
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    )
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    throw new ModelAdmissionError("CORRUPT");
  };
  const json = canonical(pricing);
  if (Buffer.byteLength(json, "utf8") > 1_048_576)
    throw new ModelAdmissionError("CORRUPT");
  return Object.freeze({
    json,
    digest: createHash("sha256").update(json).digest("hex"),
  });
}
