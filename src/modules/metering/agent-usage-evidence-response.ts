import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import { agentEvidenceEnvelopeSchema } from "../../generated/agent-usage-v2/evidence-http-schema.gen.js";
import type { FinalModelCallUsageEvidenceEnvelope } from "../../generated/agent-usage-v2/evidence-http.gen.js";
import { bindSealedAgentUsageEvidence } from "./agent-usage-evidence.js";
import type { ExpectedAgentUsageEvidence } from "./agent-usage-evidence.js";
import { parseAgentEvidenceEnvelopeJson } from "./agent-usage-json.js";
import { AgentUsageReaderError } from "./agent-usage-evidence-reader.error.js";

const ajv = new Ajv2020({ strict: true, ownProperties: true });
formatsModule.default(ajv);
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
