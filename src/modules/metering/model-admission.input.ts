import {
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import { billingHeaderCount } from "../../infrastructure/auth/billing-identity-header.js";
import type { AdmissionCreateRequest } from "../../generated/billing-api/types.gen.js";
export const modelAdmissionPath = "/v1/internal/billing/admissions";
export function modelAdmissionContext(
  request: FastifyRequest,
  signal: AbortSignal,
) {
  const context = request.billingPersonalContext;
  if (context === undefined) throw new InternalServerErrorException();
  return {
    tenantId: context.tenantId,
    actorId: context.subjectId,
    requestId: request.id,
    signal,
  };
}
export function readModelAdmissionInput(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
) {
  const key = request.headers["idempotency-key"],
    token = request.headers["x-billing-consumption-token"],
    mime = request.headers["content-type"];
  if (
    request.raw.url !== modelAdmissionPath ||
    typeof mime !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(mime) ||
    billingHeaderCount(request.raw.rawHeaders, "idempotency-key") !== 1 ||
    typeof key !== "string" ||
    !/^[\x21-\x7e]{8,128}$/u.test(key) ||
    billingHeaderCount(
      request.raw.rawHeaders,
      "x-billing-consumption-token",
    ) !== 1 ||
    typeof token !== "string" ||
    !/^[\x21-\x7e]{1,16384}$/u.test(token) ||
    !schemas.acceptsRequest("AdmissionCreateRequest", request.body)
  )
    throw new BadRequestException();
  const b = request.body as AdmissionCreateRequest;
  return {
    command: {
      runId: b.run_id,
      attemptId: b.attempt_id,
      requestRef: b.request_ref,
      attemptBindingDigest: b.attempt_binding_digest,
      plannedDigest: b.planned_digest,
      finalRequestDigest: b.final_request_digest,
      idempotencyKey: key,
    },
    consumptionToken: token,
  };
}
export function readModelAdmissionId(request: FastifyRequest): string {
  const id = (request.params as { admission_id?: unknown }).admission_id;
  const length = request.headers["content-length"];
  if (
    request.headers["transfer-encoding"] !== undefined ||
    billingHeaderCount(request.raw.rawHeaders, "transfer-encoding") !== 0 ||
    (length !== undefined &&
      (length !== "0" ||
        billingHeaderCount(request.raw.rawHeaders, "content-length") !== 1))
  )
    throw new BadRequestException();
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      id,
    ) ||
    request.raw.url !== `${modelAdmissionPath}/${id}` ||
    request.body !== undefined
  )
    throw new BadRequestException();
  return id;
}
