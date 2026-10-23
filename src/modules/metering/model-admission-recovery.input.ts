import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import { billingHeaderCount } from "../../infrastructure/auth/billing-identity-header.js";
import type { AdmissionCreateRequest } from "../../generated/billing-api/types.gen.js";
import {
  modelAdmissionPath,
  modelAdmissionCommand,
} from "./model-admission.input.js";
export function readModelAdmissionRecoveryInput(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
) {
  const key = request.headers["idempotency-key"],
    mime = request.headers["content-type"];
  if (
    request.raw.url !== `${modelAdmissionPath}/recover` ||
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
    !schemas.acceptsRequest("AdmissionCreateRequest", request.body)
  )
    throw new BadRequestException();
  return modelAdmissionCommand(request.body as AdmissionCreateRequest, key);
}
