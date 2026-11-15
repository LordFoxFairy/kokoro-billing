import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { TransactionService } from "../../database/transaction.service.js";
import type { CommandReceiptRepository } from "../../database/command-receipt.repository.js";
import type { AuditAppender } from "../../database/audit-appender.js";
import type { ResultCodec } from "../../database/command-receipt.types.js";
import {
  modelAdmissionIntent,
  modelAdmissionResultCodec,
} from "./model-admission-codec.js";
import type {
  ModelAdmissionCommand,
  ModelAdmissionContext,
} from "./model-admission.types.js";
import { ModelAdmissionError } from "./model-admission.error.js";

export type UnreservedCloseCommand = ModelAdmissionCommand &
  Readonly<{
    evidenceEventId: string;
    evidenceRevision: string;
    evidenceDigest: string;
  }>;
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const identifier = z.string().uuid();
const schema = z
  .object({
    schemaVersion: z.literal(1),
    closureRef: identifier,
    status: z.literal("unreserved_closed"),
    runId: z.string().min(1).max(512),
    attemptId: identifier,
    requestRef: z.string().min(8).max(128),
    attemptBindingDigest: digest,
    plannedDigest: digest,
    finalRequestDigest: digest,
    evidenceEventId: identifier,
    evidenceRevision: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$(?![\s\S])/u)
      .refine((v) => BigInt(v) <= 9223372036854775807n),
    evidenceDigest: digest,
    closedAt: z.string().datetime(),
  })
  .strict();
export type UnreservedClosure = z.infer<typeof schema>;
const codec: ResultCodec<UnreservedClosure> = {
  schemaVersion: 1,
  encode: (value) => schema.parse(value),
  decode: (value) => schema.parse(value),
};
const commandName = "model.close-unreserved";
type Intent = ReturnType<typeof modelAdmissionIntent>;

/** Read only under the existing admission command/request locks. Not a settlement. */
export async function assertUnreservedAdmissionOpen(
  tx: TransactionService,
  intent: Intent,
): Promise<void> {
  const found = await tx
    .requireActiveTransaction(intent.context.tenantId, "write")
    .billing_command_receipt.findFirst({
      where: {
        tenant_id: intent.context.tenantId,
        command_namespace: "admission",
        api_surface: "internal",
        command_name: commandName,
        OR: [
          { command_identity: intent.expected.attemptId },
          {
            result_json: {
              path: ["requestRef"],
              equals: intent.expected.requestRef,
            },
          },
        ],
      },
    });
  if (found) {
    if (found.status !== "succeeded") throw new ModelAdmissionError("CORRUPT");
    codec.decode(found.result_json);
    throw new ModelAdmissionError("CONFLICT");
  }
}

/** Cancels the original unfunded command. No Credit/IAM/Agent port or money writes. */
export async function closeUnreservedAdmission(
  tx: TransactionService,
  receipts: CommandReceiptRepository,
  audit: AuditAppender,
  context: ModelAdmissionContext,
  command: UnreservedCloseCommand,
): Promise<UnreservedClosure> {
  const original = modelAdmissionIntent(context, {
    runId: command.runId,
    attemptId: command.attemptId,
    requestRef: command.requestRef,
    attemptBindingDigest: command.attemptBindingDigest,
    plannedDigest: command.plannedDigest,
    finalRequestDigest: command.finalRequestDigest,
    idempotencyKey: command.idempotencyKey,
  });
  const scope = original.context;
  if (
    command.idempotencyKey !== command.requestRef ||
    !/^[!-~]{8,128}$/u.test(command.requestRef)
  )
    throw new ModelAdmissionError("INVALID");
  const expected = schema
    .omit({
      schemaVersion: true,
      closureRef: true,
      status: true,
      closedAt: true,
    })
    .parse({
      runId: original.expected.runId,
      attemptId: original.expected.attemptId,
      requestRef: original.expected.requestRef,
      attemptBindingDigest: original.expected.attemptBindingDigest,
      plannedDigest: original.expected.plannedDigest,
      finalRequestDigest: original.expected.finalRequestDigest,
      evidenceEventId: command.evidenceEventId,
      evidenceRevision: command.evidenceRevision,
      evidenceDigest: command.evidenceDigest,
    });
  const receipt = {
    ...original.receipt,
    commandName,
    payloadDigest: createHash("sha256")
      .update(
        "model-close-unreserved:1\n" +
          original.receipt.payloadDigest +
          "\n" +
          JSON.stringify(expected),
      )
      .digest("hex"),
  };
  const guard = () => {
    if (scope.signal.aborted) throw new ModelAdmissionError("ABORTED");
  };
  guard();
  return tx.runRoot(
    {
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      operation: commandName,
      mode: "write",
    },
    async () => {
      // Same original command identity/key locks as create; no polling/absence heuristic.
      if (await receipts.recover(original.receipt, modelAdmissionResultCodec))
        throw new ModelAdmissionError("CONFLICT");
      const client = tx.requireActiveTransaction(scope.tenantId, "write");
      for (const key of [
        `model-admission:run:${scope.tenantId}:${expected.runId}`,
        `model-admission:request:${scope.tenantId}:${expected.requestRef}`,
      ].sort())
        await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${key},0))`;
      guard();
      if (
        (await client.billing_admission.findFirst({
          where: {
            tenant_id: scope.tenantId,
            OR: [
              { attempt_id: expected.attemptId },
              { request_ref: expected.requestRef },
            ],
          },
        })) ||
        (await client.billing_credit_hold.findUnique({
          where: {
            tenant_id_idempotency_key: {
              tenant_id: scope.tenantId,
              idempotency_key: `model-attempt:${expected.attemptId}`,
            },
          },
        }))
      )
        throw new ModelAdmissionError("CONFLICT");
      const previous = await receipts.recover(receipt, codec);
      if (previous !== null) return previous.value;
      await assertUnreservedAdmissionOpen(tx, original);
      const result = await receipts.execute(receipt, codec, async () => {
        guard();
        const value: UnreservedClosure = schema.parse({
          ...expected,
          schemaVersion: 1,
          closureRef: randomUUID(),
          status: "unreserved_closed",
          closedAt: new Date().toISOString(),
        });
        await audit.append({
          tenantId: scope.tenantId,
          subjectId: scope.actorId,
          action: commandName,
          resourceType: "model_attempt",
          resourceId: expected.attemptId,
          reason: "unreserved_command_closed",
          payload: {
            closure_ref: value.closureRef,
            run_id: expected.runId,
            evidence_event_id: expected.evidenceEventId,
            evidence_revision: expected.evidenceRevision,
            evidence_digest: expected.evidenceDigest,
            original_command_digest: original.receipt.payloadDigest,
          },
        });
        guard();
        return value;
      });
      guard();
      return result.value;
    },
  );
}
