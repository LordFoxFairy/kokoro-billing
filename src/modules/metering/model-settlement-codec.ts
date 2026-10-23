import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ResultCodec,
  CommandReceiptRequest,
} from "../../database/command-receipt.types.js";
import { validateModelAdmissionRead } from "./model-admission-codec.js";
import type { ModelAdmissionContext } from "./model-admission.types.js";
import { ModelAdmissionError } from "./model-admission.error.js";
const uuid = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]+$/u);
const digest = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);
const number = z
  .string()
  .max(19)
  .refine((s) => {
    try {
      return (
        BigInt(s) >= 0n &&
        BigInt(s) <= 9223372036854775807n &&
        BigInt(s).toString() === s
      );
    } catch {
      return false;
    }
  });
const commandSchema = z
  .object({
    admissionId: uuid,
    eventId: uuid,
    revision: number.refine((s) => s !== "0"),
    digest,
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .refine((s) => [...s].every((c) => c >= "!" && c <= "~")),
  })
  .strict();
export type ModelSettlementCommand = Readonly<z.infer<typeof commandSchema>>;
const resultSchema = z
  .object({
    schemaVersion: z.literal(1),
    admissionId: uuid,
    eventId: uuid,
    revision: number,
    digest,
    status: z.enum(["captured", "released", "pending_reconciliation"]),
    reason: z.enum(["unknown_usage_or_outcome", "budget_exceeded"]).nullable(),
    capturedMicros: number,
    releasedMicros: number,
    usageEventId: uuid.nullable(),
    settlementId: uuid.nullable(),
    updatedAt: z
      .string()
      .datetime()
      .refine((s) => new Date(s).toISOString() === s),
    evidenceJson: z.string().min(1).max(65536),
  })
  .strict();
export type ModelSettlementResult = Readonly<z.infer<typeof resultSchema>>;
export const modelSettlementResultCodec: ResultCodec<ModelSettlementResult> = {
  schemaVersion: 1,
  encode: (v) => resultSchema.parse(v),
  decode: (v) => Object.freeze(resultSchema.parse(v)),
};
export function modelSettlementIntent(
  context: ModelAdmissionContext,
  command: ModelSettlementCommand,
): Readonly<{
  context: ModelAdmissionContext;
  command: ModelSettlementCommand;
  receipt: CommandReceiptRequest;
}> {
  try {
    const copied = commandSchema.parse(structuredClone(command));
    validateModelAdmissionRead(context, copied.admissionId);
    const scope = Object.freeze({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestId: context.requestId,
      signal: context.signal,
    });
    return Object.freeze({
      context: scope,
      command: Object.freeze(copied),
      receipt: Object.freeze({
        tenantId: scope.tenantId,
        namespace: "admission",
        commandName: "model.settle",
        commandIdentity: copied.admissionId + ":" + copied.eventId,
        idempotencyKey: copied.idempotencyKey,
        requestSchemaVersion: 1,
        payloadDigest: createHash("sha256")
          .update(
            JSON.stringify([
              "kokoro.billing.model-settle:1",
              scope.tenantId,
              scope.actorId,
              copied.admissionId,
              copied.eventId,
              copied.revision,
              copied.digest,
            ]),
          )
          .digest("hex"),
      }),
    });
  } catch {
    throw new ModelAdmissionError("INVALID");
  }
}
