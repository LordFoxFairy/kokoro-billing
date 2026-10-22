import {
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type {
  AdminMeteringPolicyPublishRequest,
  AdminMeteringRatePublishRequest,
} from "../../generated/billing-api/types.gen.js";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import { billingHeaderCount } from "../../infrastructure/auth/billing-identity-header.js";
import {
  currentMeteringProfileRef,
  currentMeteringFailurePolicyRef,
} from "./metering-policy-artifact.js";
import {
  encodeMeteringRatePublicationCommand,
  encodeMeteringPolicyPublicationCommand,
} from "./metering-pricing-revision-codec.js";
import type {
  MeteringPolicyRevisionDraft,
  MeteringPublicationCommand,
  MeteringRateRevisionDraft,
} from "./metering-pricing-revision.types.js";

export function meteringAdminContext(request: FastifyRequest) {
  const context = request.billingPersonalContext;
  if (context === undefined) throw new InternalServerErrorException();
  return {
    tenantId: context.tenantId,
    operatorId: context.subjectId,
    role: "billing.admin",
  };
}
export function assertMeteringReadRequest(request: FastifyRequest): void {
  if (
    request.url.includes("?") ||
    request.body !== undefined ||
    request.headers["transfer-encoding"] !== undefined ||
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0")
  )
    throw new BadRequestException();
}
function input(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
  name: "AdminMeteringRatePublishRequest" | "AdminMeteringPolicyPublishRequest",
) {
  const key = request.headers["idempotency-key"],
    mime = request.headers["content-type"];
  if (
    request.url.includes("?") ||
    typeof mime !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(mime) ||
    billingHeaderCount(request.raw.rawHeaders, "idempotency-key") !== 1 ||
    typeof key !== "string" ||
    !/^[\x20-\x7e]{8,128}$/u.test(key) ||
    !schemas.acceptsRequest(name, request.body)
  )
    throw new BadRequestException();
  const context = meteringAdminContext(request);
  return { key, context };
}
export function readMeteringRateCommand(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
): MeteringPublicationCommand<MeteringRateRevisionDraft> {
  const { key, context } = input(
    request,
    schemas,
    "AdminMeteringRatePublishRequest",
  );
  const body = request.body as AdminMeteringRatePublishRequest;
  const config = body.configuration;
  const command: MeteringPublicationCommand<MeteringRateRevisionDraft> = {
    tenantId: context.tenantId,
    actorId: context.operatorId,
    publicationIdentity: body.publication_id,
    idempotencyKey: key,
    reason: body.reason,
    draft: {
      schemaVersion: "2",
      tenantId: context.tenantId,
      effectiveFrom: config.effective_from,
      verifiedAt: config.verified_at,
      sourceRef: config.source_ref,
      profileRef: currentMeteringProfileRef,
      rates: config.rates.map((rate) => ({
        modelRevision: {
          id: rate.model_revision.id,
          contentDigest: rate.model_revision.content_digest,
        },
        providerRef: rate.provider_ref,
        environment: rate.environment,
        pricingAccountRef: rate.pricing_account_ref,
        modelRef: rate.model_ref,
        modelVersion: rate.model_version,
        bucket: rate.bucket,
        unit: rate.unit,
        currencyCode: rate.currency_code,
        minorPerUnit: rate.minor_per_unit,
        applicability:
          rate.applicability.kind === "all"
            ? { kind: "all" }
            : {
                kind: "range",
                dimension: rate.applicability.dimension,
                unit: rate.applicability.unit,
                lowerInclusive: rate.applicability.lower_inclusive,
                upperExclusive: rate.applicability.upper_exclusive,
              },
      })),
    },
  };
  try {
    if (body.reason.trim().length === 0) throw new Error();
    encodeMeteringRatePublicationCommand(command);
  } catch {
    throw new BadRequestException();
  }
  return command;
}
export function readMeteringPolicyCommand(
  request: FastifyRequest,
  schemas: BillingSchemaValidator,
): MeteringPublicationCommand<MeteringPolicyRevisionDraft> {
  const { key, context } = input(
    request,
    schemas,
    "AdminMeteringPolicyPublishRequest",
  );
  const body = request.body as AdminMeteringPolicyPublishRequest;
  const config = body.configuration;
  const command: MeteringPublicationCommand<MeteringPolicyRevisionDraft> = {
    tenantId: context.tenantId,
    actorId: context.operatorId,
    publicationIdentity: body.publication_id,
    idempotencyKey: key,
    reason: body.reason,
    draft: {
      schemaVersion: "2",
      tenantId: context.tenantId,
      effectiveFrom: config.effective_from,
      verifiedAt: config.verified_at,
      sourceRef: config.source_ref,
      profileRef: currentMeteringProfileRef,
      currencyCode: config.currency_code,
      multiplier: config.multiplier,
      creditMicrosPerMinor: config.credit_micros_per_minor,
      maxAttemptCredits: config.max_attempt_credits,
      roundingVersion: "attempt-credit-ceil-v2",
      failurePolicyRef: currentMeteringFailurePolicyRef(),
    },
  };
  try {
    if (
      body.reason.trim().length === 0 ||
      BigInt(config.multiplier.numerator) <= 0n ||
      BigInt(config.credit_micros_per_minor.numerator) <= 0n
    )
      throw new Error();
    encodeMeteringPolicyPublicationCommand(command);
  } catch {
    throw new BadRequestException();
  }
  return command;
}
