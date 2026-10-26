import {
  agentBoundHttpSchemas,
  agentBoundHttpErrorCodes,
} from "../../generated/agent-model-call-bound-v1/bound-http-schema.gen.js";
import type {
  ModelCallBoundEnvelope,
  ErrorEnvelope,
} from "../../generated/agent-model-call-bound-v1/bound-http.gen.js";
import { decodeAgentModelCallBound } from "./agent-model-call-bound.js";
import type { ExpectedAgentModelCallBound } from "./agent-model-call-bound.js";
import { parseAgentBoundEnvelopeJson } from "./agent-usage-json.js";
import { createAgentModelCallValidator } from "./agent-model-call-validation.js";
import { agentEvidenceEnvelopeSchema } from "../../generated/agent-usage-v2/evidence-http-schema.gen.js";
import type { FinalModelCallUsageEvidenceEnvelope } from "../../generated/agent-usage-v2/evidence-http.gen.js";
import { bindSealedAgentUsageEvidence } from "./agent-usage-evidence.js";
import type { ExpectedAgentUsageEvidence } from "./agent-usage-evidence.js";
import { parseAgentEvidenceEnvelopeJson } from "./agent-usage-json.js";
import { AgentUsageReaderError } from "./agent-usage-evidence-reader.error.js";

const ajv = createAgentModelCallValidator();
const validate = ajv.compile<FinalModelCallUsageEvidenceEnvelope>(
  agentEvidenceEnvelopeSchema,
);

export function decodeAgentEvidenceResponse(
  raw: Uint8Array,
  expected: ExpectedAgentUsageEvidence,
  requestId: string,
) {
  const value = parseAgentEvidenceEnvelopeJson(raw).value;
  const valid = validate(value);
  validate.errors = null;
  if (!valid) throw new AgentUsageReaderError("CONTRACT_INVALID");
  const { data, meta } = value;
  if (
    meta.request_id !== requestId ||
    data.artifact_version !== "2.0.0" ||
    data.attempt_id !== expected.identity.attempt_id ||
    data.event_id !== expected.identity.event_id ||
    data.revision !== expected.revision ||
    data.evidence_digest !== expected.digest
  )
    throw new AgentUsageReaderError("CONTRACT_INVALID");
  const encoded = data.evidence_bytes_base64url;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded)
    throw new AgentUsageReaderError("CONTRACT_INVALID");
  return bindSealedAgentUsageEvidence(bytes, expected);
}

const validateBoundEnvelope = ajv.compile<ModelCallBoundEnvelope>({
  ...agentBoundHttpSchemas,
  $ref: "#/$defs/ModelCallBoundEnvelope",
});
const validateBoundError = ajv.compile<ErrorEnvelope>({
  ...agentBoundHttpSchemas,
  $ref: "#/$defs/ErrorEnvelope",
});

export function decodeAgentBoundResponse(
  raw: Uint8Array,
  expected: ExpectedAgentModelCallBound,
  requestId: string,
  status: number,
) {
  const value = parseAgentBoundEnvelopeJson(raw).value;
  if (status !== 200) {
    const valid = validateBoundError(value);
    validateBoundError.errors = null;
    if (!valid || value.meta.request_id !== requestId)
      throw new AgentUsageReaderError("CONTRACT_INVALID");
    const known = Object.entries(agentBoundHttpErrorCodes).find(
      ([key]) => key === String(status),
    );
    if (!known || known[1] !== value.error.code)
      throw new AgentUsageReaderError("CONTRACT_INVALID");
    switch (status) {
      case 401:
      case 403:
        throw new AgentUsageReaderError("DENIED");
      case 404:
        throw new AgentUsageReaderError("NOT_FOUND");
      case 409:
        throw new AgentUsageReaderError("STALE");
      case 410:
        throw new AgentUsageReaderError("EXPIRED");
      case 503:
        throw new AgentUsageReaderError("UNAVAILABLE");
      default:
        throw new AgentUsageReaderError("CONTRACT_INVALID");
    }
  }
  const valid = validateBoundEnvelope(value);
  validateBoundEnvelope.errors = null;
  if (!valid || value.meta.request_id !== requestId)
    throw new AgentUsageReaderError("CONTRACT_INVALID");
  const data = value.data;
  if (
    data.planned_binding_ref !== expected.plannedBindingRef ||
    data.planned_binding_digest !== expected.plannedBindingDigest ||
    data.execution_bound_ref !== expected.executionBoundRef ||
    data.execution_bound_digest !== expected.executionBoundDigest
  )
    throw new AgentUsageReaderError("CONTRACT_INVALID");
  const decode = (encoded: string): Buffer => {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > 65536 || bytes.toString("base64url") !== encoded)
      throw new AgentUsageReaderError("CONTRACT_INVALID");
    return bytes;
  };
  return decodeAgentModelCallBound({
    plannedRaw: decode(data.planned_binding_bytes_base64url),
    boundRaw: decode(data.execution_bound_bytes_base64url),
    expected,
    now: Date.now(),
  });
}
