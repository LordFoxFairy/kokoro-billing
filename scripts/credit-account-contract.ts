import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { assertTargetOpenApi } from "./openapi-target.js";
const expectedOperation: unknown = {
  operationId: "openMyCreditAccount",
  "x-kokoro-owner": "kokoro-billing",
  "x-kokoro-visibility": "internal-owner",
  "x-kokoro-stability": "experimental",
  "x-kokoro-idempotency": "inherent",
  "x-kokoro-permission": "web-bff-delegated-self",
  "x-kokoro-identity-transport": "personal-identity-u1",
  "x-kokoro-auth-selection": {
    machine_markers: [
      "x-kokoro-service",
      "x-kokoro-internal-secret",
      "x-kokoro-subject",
    ],
    service_bearer_selects_machine: true,
    machine_partial_response: 403,
    machine_to_user_fallback: false,
  },
  security: [
    {
      serviceCaller: [],
      internalSecret: [],
      serviceBearer: [],
      tenantContext: [],
      subjectContext: [],
    },
  ],
  parameters: [
    {
      $ref: "#/components/parameters/PersonalTenantId",
    },
    {
      name: "x-kokoro-subject",
      in: "header",
      required: true,
      schema: {
        type: "string",
        minLength: 5,
        maxLength: 1363,
        pattern:
          "^u1\\.(?=[A-Za-z0-9_-])(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]|[A-Za-z0-9_-][AQgw])?$(?![\\s\\S])",
      },
    },
    {
      name: "x-kokoro-service",
      in: "header",
      required: true,
      schema: {
        type: "string",
        const: "web-bff",
      },
    },
  ],
  responses: {
    "200": {
      description: "Success",
      headers: {
        "x-request-id": {
          $ref: "#/components/headers/RequestId",
        },
        "cache-control": {
          $ref: "#/components/headers/CacheControlNoStore",
        },
      },
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/CreditAccountResponse",
          },
        },
      },
    },
    "400": {
      description: "Request failed",
      headers: {
        "x-request-id": {
          $ref: "#/components/headers/RequestId",
        },
        "cache-control": {
          $ref: "#/components/headers/CacheControlNoStore",
        },
      },
      "x-kokoro-errors": [
        {
          code: "billing.invalid_request",
          retryable: false,
        },
      ],
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ErrorResponse",
          },
        },
      },
    },
    "401": {
      description: "Authentication required",
      headers: {
        "x-request-id": {
          $ref: "#/components/headers/RequestId",
        },
        "cache-control": {
          $ref: "#/components/headers/CacheControlNoStore",
        },
      },
      "x-kokoro-errors": [
        {
          code: "billing.unauthenticated",
          retryable: false,
        },
      ],
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ErrorResponse",
          },
        },
      },
    },
    "403": {
      description: "Forbidden",
      headers: {
        "x-request-id": {
          $ref: "#/components/headers/RequestId",
        },
        "cache-control": {
          $ref: "#/components/headers/CacheControlNoStore",
        },
      },
      "x-kokoro-errors": [
        {
          code: "billing.forbidden",
          retryable: false,
        },
        {
          code: "billing.credit_account_disabled",
          retryable: false,
        },
      ],
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ErrorResponse",
          },
        },
      },
    },
    "500": {
      description: "Internal failure",
      headers: {
        "x-request-id": {
          $ref: "#/components/headers/RequestId",
        },
        "cache-control": {
          $ref: "#/components/headers/CacheControlNoStore",
        },
      },
      "x-kokoro-errors": [
        {
          code: "billing.internal_error",
          retryable: false,
        },
      ],
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ErrorResponse",
          },
        },
      },
    },
    "503": {
      description: "Dependency unavailable",
      headers: {
        "x-request-id": {
          $ref: "#/components/headers/RequestId",
        },
        "cache-control": {
          $ref: "#/components/headers/CacheControlNoStore",
        },
      },
      "x-kokoro-errors": [
        {
          code: "billing.dependency_unavailable",
          retryable: true,
        },
      ],
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/ErrorResponse",
          },
        },
      },
    },
  },
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: {
          $ref: "#/components/schemas/OpenCreditAccountRequest",
        },
      },
    },
  },
};
const expectedRequest: unknown = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
export const creditAccountBaselineDigest =
  "9ff84d5f473e2f161f5d0c496db4cee175e2b032e836e97c7e23b9576a0af3e6";
/** Current-only gate; the projection is a test/build historical oracle, never runtime wire. */
export function creditAccountBaselineSource(source: string): string {
  const doc = parse(source) as {
    info?: { version?: string };
    paths?: Record<string, Record<string, unknown>>;
    components?: { schemas?: Record<string, unknown> };
  };
  if (
    doc.info?.version !== "4.0.0-experimental.3" ||
    !isDeepStrictEqual(
      doc.paths?.["/v1/billing/me/credit-account"]?.put,
      expectedOperation,
    ) ||
    !isDeepStrictEqual(
      doc.components?.schemas?.OpenCreditAccountRequest,
      expectedRequest,
    )
  )
    throw new Error("Invalid explicit account opening contract");
  const baseline = source
    .replace("version: 4.0.0-experimental.3", "version: 4.0.0-experimental.2")
    .replace(
      /(?<= {2}\/v1\/billing\/me\/credit-account:\n) {4}put:\n[\s\S]*?(?= {4}get:\n)/u,
      "",
    )
    .replace(
      / {4}OpenCreditAccountRequest:\n[\s\S]*?(?= {4}[A-Za-z][A-Za-z0-9]*:\n)/u,
      "",
    );
  if (
    createHash("sha256").update(baseline).digest("hex") !==
    creditAccountBaselineDigest
  )
    throw new Error("Billing main experimental.2 baseline bytes changed");
  assertTargetOpenApi(parse(baseline) as unknown);
  return baseline;
}
export function assertCreditAccountContract(source: string): void {
  creditAccountBaselineSource(source);
}
