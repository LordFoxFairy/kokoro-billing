// Generated from immutable Agent HTTP7.1 schema. Do not edit.
export const SOURCE_SHA256 =
  "df6427dd26f2ee5ed6550b04464e6aa4e0d791c480e6cb152df2ae381b94cff0";
export const agentBoundHttpSchemas = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: {
    ModelCallBoundEnvelope: {
      type: "object",
      required: ["data", "meta"],
      properties: {
        data: { $ref: "#/$defs/ModelCallBoundData" },
        meta: { $ref: "#/$defs/Meta" },
      },
      additionalProperties: false,
    },
    ModelCallBoundData: {
      type: "object",
      additionalProperties: false,
      required: [
        "planned_binding_ref",
        "planned_binding_digest",
        "planned_binding_bytes_base64url",
        "execution_bound_ref",
        "execution_bound_digest",
        "execution_bound_artifact_version",
        "execution_bound_revision",
        "execution_bound_bytes_base64url",
      ],
      properties: {
        planned_binding_ref: { type: "string", minLength: 1 },
        planned_binding_digest: {
          type: "string",
          minLength: 1,
          pattern: "^[a-f0-9]{64}$",
        },
        planned_binding_bytes_base64url: {
          type: "string",
          minLength: 1,
          pattern: "^[A-Za-z0-9_-]+$",
          maxLength: 87382,
        },
        execution_bound_ref: { type: "string", minLength: 1 },
        execution_bound_digest: {
          type: "string",
          minLength: 1,
          pattern: "^[a-f0-9]{64}$",
        },
        execution_bound_artifact_version: { type: "string", const: "1.0.0" },
        execution_bound_revision: { type: "string", const: "1" },
        execution_bound_bytes_base64url: {
          type: "string",
          minLength: 1,
          pattern: "^[A-Za-z0-9_-]+$",
          maxLength: 87382,
        },
      },
    },
    ErrorEnvelope: {
      type: "object",
      required: ["error", "meta"],
      properties: {
        error: { $ref: "#/$defs/Error" },
        meta: { $ref: "#/$defs/Meta" },
      },
      additionalProperties: false,
    },
    Error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        details: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    Meta: {
      type: "object",
      required: ["request_id"],
      properties: { request_id: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
  },
} as const;
export const agentBoundHttpErrorCodes = {
  "400": "invalid_model_call_bound_identity",
  "401": "agent_reader_auth_failed",
  "403": "agent_reader_forbidden",
  "404": "model_call_bound_not_found",
  "409": "model_call_bound_stale",
  "410": "model_call_bound_expired",
  "503": "agent_reader_unavailable",
} as const;
