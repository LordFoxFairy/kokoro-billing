import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import { billingHeaderCount } from "../../infrastructure/auth/billing-identity-header.js";
import type {
  AdmissionUnreservedCloseRequest,
  AdmissionUnreservedCloseResponse,
} from "../../generated/billing-api/types.gen.js";
import {
  modelAdmissionCommand,
  modelAdmissionPath,
} from "./model-admission.input.js";
import type {
  UnreservedCloseCommand,
  UnreservedClosure,
} from "./model-unreserved-closure.js";

export function readUnreservedCloseInput(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
): UnreservedCloseCommand {
  const key = request.headers["idempotency-key"],
    mime = request.headers["content-type"];
  if (
    request.raw.url !== `${modelAdmissionPath}/close-unreserved` ||
    typeof mime !== "string" ||
    billingHeaderCount(request.raw.rawHeaders, "content-type") !== 1 ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$(?![\s\S])/iu.test(mime) ||
    typeof key !== "string" ||
    billingHeaderCount(request.raw.rawHeaders, "idempotency-key") !== 1 ||
    !/^[!-~]{8,128}$/u.test(key) ||
    billingHeaderCount(request.raw.rawHeaders, "x-billing-execution-proof") !==
      0 ||
    billingHeaderCount(
      request.raw.rawHeaders,
      "x-billing-consumption-token",
    ) !== 0 ||
    !schemas.acceptsRequest("AdmissionUnreservedCloseRequest", request.body)
  )
    throw new BadRequestException();
  const b = request.body as AdmissionUnreservedCloseRequest;
  if (key !== b.request_ref) throw new BadRequestException();
  return {
    ...modelAdmissionCommand(b, key),
    evidenceEventId: b.evidence_event_id,
    evidenceRevision: b.evidence_revision,
    evidenceDigest: b.evidence_digest,
  };
}
export function mapUnreservedClosure(
  v: UnreservedClosure,
): AdmissionUnreservedCloseResponse {
  return {
    data: {
      run_id: v.runId,
      attempt_id: v.attemptId,
      request_ref: v.requestRef,
      attempt_binding_digest: v.attemptBindingDigest,
      planned_digest: v.plannedDigest,
      final_request_digest: v.finalRequestDigest,
      evidence_event_id: v.evidenceEventId,
      evidence_revision: v.evidenceRevision,
      evidence_digest: v.evidenceDigest,
      closure_ref: v.closureRef,
      status: v.status,
      closed_at: v.closedAt,
    },
  };
}
