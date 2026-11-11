import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import { billingHeaderCount } from "../../infrastructure/auth/billing-identity-header.js";
import type { AdmissionSettlementRequest } from "../../generated/billing-api/types.gen.js";
import { modelAdmissionPath } from "./model-admission.input.js";
import type { ModelSettlementCommand } from "./model-settlement-codec.js";

export function readModelSettlementInput(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
): ModelSettlementCommand {
  const id = (request.params as { admission_id?: unknown }).admission_id;
  const key = request.headers["idempotency-key"],
    mime = request.headers["content-type"];
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/u.test(
      id,
    ) ||
    request.raw.url !== `${modelAdmissionPath}/${id}/settle` ||
    typeof mime !== "string" ||
    billingHeaderCount(request.raw.rawHeaders, "content-type") !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$(?![\s\S])/iu.test(mime) ||
    typeof key !== "string" ||
    billingHeaderCount(request.raw.rawHeaders, "idempotency-key") !== 1 ||
    !/^[\x21-\x7e]{8,128}$(?![\s\S])/u.test(key) ||
    billingHeaderCount(request.raw.rawHeaders, "x-billing-execution-proof") !==
      0 ||
    billingHeaderCount(
      request.raw.rawHeaders,
      "x-billing-consumption-token",
    ) !== 0 ||
    !schemas.acceptsRequest("AdmissionSettlementRequest", request.body)
  )
    throw new BadRequestException();
  const body = request.body as AdmissionSettlementRequest;
  return {
    admissionId: id,
    runId: body.run_id,
    eventId: body.evidence_event_id,
    revision: body.evidence_revision,
    digest: body.evidence_digest,
    idempotencyKey: key,
  };
}
