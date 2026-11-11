import {
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { AdminCreditGrantRequest } from "../../generated/billing-api/types.gen.js";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import {
  assertBillingIdentity,
  billingHeaderCount,
} from "../../infrastructure/auth/billing-identity-header.js";
import type { GrantCreditInput } from "./credit.types.js";

export function readAdminCreditGrantInput(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
): GrantCreditInput {
  const key = request.headers["idempotency-key"];
  const mime = request.headers["content-type"];
  if (
    request.url.includes("?") ||
    typeof mime !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(mime) ||
    billingHeaderCount(request.raw.rawHeaders, "idempotency-key") !== 1 ||
    typeof key !== "string" ||
    !/^[\x20-\x7e]{8,128}$/u.test(key) ||
    !schemas.acceptsRequest("AdminCreditGrantRequest", request.body)
  )
    throw new BadRequestException();
  const body = request.body as AdminCreditGrantRequest;
  let amount: bigint;
  try {
    assertBillingIdentity(body.subject_id, "subject");
    if (
      body.reason.trim().length === 0 ||
      [...body.reason].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point === 0 || (point >= 0xd800 && point <= 0xdfff);
      })
    )
      throw new Error();
    amount = BigInt(body.amount_credits) * 1_000_000n;
    if (
      amount > 9_223_372_036_854_775_807n ||
      new Date(body.effective_at).toISOString() !== body.effective_at
    )
      throw new Error();
  } catch {
    throw new BadRequestException();
  }
  const context = request.billingPersonalContext;
  if (context === undefined) throw new InternalServerErrorException();
  return {
    tenantId: context.tenantId,
    actorId: context.subjectId,
    subjectId: body.subject_id,
    amountMicros: amount,
    idempotencyKey: key,
    commandIdentity: body.funding_id,
    sourceKind: "admin_credit",
    sourceRef: body.funding_id,
    programKey: "admin_credit_v1",
    reason: body.reason,
    effectiveAt: new Date(body.effective_at),
  };
}
