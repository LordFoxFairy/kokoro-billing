// Generated from immutable Agent HTTP6 schema. Do not edit.
export const SOURCE_SHA256 =
  "e4d30178f2330744b374788abf7e6d23bbf8d7841dcd01537063c705dc18a8db";
export const agentEvidenceEnvelopeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $ref: "#/$defs/FinalModelCallUsageEvidenceEnvelope",
  $defs: {
    FinalModelCallUsageEvidenceEnvelope: {
      type: "object",
      required: ["data", "meta"],
      properties: {
        data: { $ref: "#/$defs/FinalModelCallUsageEvidence" },
        meta: { $ref: "#/$defs/Meta" },
      },
      additionalProperties: false,
    },
    FinalModelCallUsageEvidence: {
      type: "object",
      required: [
        "artifact_version",
        "attempt_id",
        "event_id",
        "revision",
        "evidence_bytes_base64url",
        "evidence_digest",
        "sealed",
        "observed_at",
      ],
      properties: {
        artifact_version: { type: "string", enum: ["1.0.0", "2.0.0"] },
        attempt_id: { type: "string", format: "uuid" },
        event_id: { type: "string", format: "uuid" },
        revision: { type: "string", pattern: "^[1-9][0-9]*$" },
        evidence_bytes_base64url: {
          type: "string",
          minLength: 1,
          maxLength: 87382,
          pattern: "^[A-Za-z0-9_-]+$",
        },
        evidence_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        sealed: { type: "boolean", const: true },
        observed_at: {
          type: "string",
          format: "date-time",
          pattern:
            "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
        },
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
