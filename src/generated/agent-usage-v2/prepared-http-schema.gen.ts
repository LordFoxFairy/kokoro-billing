// Generated from immutable Agent HTTP7.1 schema. Do not edit.
export const SOURCE_SHA256 =
  "6c0f532d983367ce3a22e05ffab00f83b7a4481de04f7121e72dd2a5098365a5";
export const agentPreparedEnvelopeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $ref: "#/$defs/PreparedModelCallSnapshotEnvelope",
  $defs: {
    PreparedModelCallSnapshotEnvelope: {
      type: "object",
      required: ["data", "meta"],
      properties: {
        data: { $ref: "#/$defs/PreparedModelCallSnapshot" },
        meta: { $ref: "#/$defs/Meta" },
      },
      additionalProperties: false,
    },
    PreparedModelCallSnapshot: {
      type: "object",
      additionalProperties: false,
      required: [
        "binding_version",
        "attempt_id",
        "status",
        "attempt_binding_bytes_base64url",
        "attempt_binding_digest",
        "planned_bytes_base64url",
        "planned_digest",
        "authorization_bytes_base64url",
        "authorization_digest",
        "final_request_binding_version",
        "final_request_digest",
        "prepared_at",
        "observed_at",
        "lease_expires_at",
      ],
      properties: {
        binding_version: { type: "string", const: "2.0.0" },
        attempt_id: { type: "string", format: "uuid" },
        status: {
          type: "string",
          enum: ["prepared", "authorization_pending", "authorized"],
        },
        attempt_binding_bytes_base64url: {
          type: "string",
          minLength: 1,
          maxLength: 87382,
          pattern: "^[A-Za-z0-9_-]+$",
          description:
            "Original canonical RFC8785 UTF-8 JSON bytes, 1..65536, unpadded canonical base64url. Decoded shape is usage/v2 EvidenceIdentity with event_id removed; no other fields added. Its digest is ordinary SHA256 of these exact bytes.",
        },
        attempt_binding_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        planned_bytes_base64url: {
          type: "string",
          minLength: 1,
          maxLength: 87382,
          pattern: "^[A-Za-z0-9_-]+$",
          description:
            "Original canonical usage/v2 PlannedBinding bytes; binding_version must be 2.0.0. Ordinary SHA256, not the final evidence digest domain. Never actual commercial attribution.",
        },
        planned_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        authorization_bytes_base64url: {
          type: "string",
          minLength: 1,
          maxLength: 87382,
          pattern: "^[A-Za-z0-9_-]+$",
          description:
            "Current canonical usage/v2 AuthorizationObservation bytes: prepared/not_requested, authorization_pending/requested_unknown with original request_ref, or authorized/granted with original request_ref and admission_ref. This observation changes with state; it is not the creation receipt.",
        },
        authorization_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        final_request_binding_version: { type: "integer", const: 1 },
        final_request_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        prepared_at: {
          type: "string",
          format: "date-time",
          pattern:
            "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
        },
        observed_at: {
          type: "string",
          format: "date-time",
          pattern:
            "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
          description:
            "Database time for the single joined read; lease expiry is observation, never a renewable dispatch permit.",
        },
        lease_expires_at: {
          type: "string",
          format: "date-time",
          pattern:
            "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
        },
      },
    },
    Meta: {
      type: "object",
      required: ["request_id"],
      properties: { request_id: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
  },
} as const;
