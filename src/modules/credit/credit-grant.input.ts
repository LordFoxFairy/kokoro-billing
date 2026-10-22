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

/** The grant contract is a small flat string object. Preserve UTF-8 and reject
 * duplicate decoded names before native JSON parsing can discard a command. */
export function parseAdminCreditGrantJson(raw: Buffer): unknown {
  if (raw.length === 0 || raw.length > 16384) throw new BadRequestException();
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
    value = JSON.parse(text) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== "string")
    )
      throw new Error();
    const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"/gu) ?? [];
    const names = new Set<string>();
    for (let index = 0; index < tokens.length; index += 2) {
      const name: unknown = JSON.parse(tokens[index] ?? "null");
      if (typeof name !== "string" || names.has(name)) throw new Error();
      names.add(name);
    }
    if (
      tokens.length !== names.size * 2 ||
      names.size !== Object.keys(value).length
    )
      throw new Error();
  } catch {
    throw new BadRequestException();
  }
  return value;
}

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
