import { agentUsageSchema } from "../../generated/agent-usage-v2/schema.gen.js";
import { AgentUsageEvidenceError } from "./agent-usage-evidence.error.js";

import {
  parseStrictMeteringJson,
  type MeteringJson,
} from "./strict-metering-json.js";
export type UsageJson = MeteringJson;

function parseAgentJson(
  raw: Uint8Array,
  maxBytes: number,
  preparedEnvelope = false,
) {
  try {
    return parseStrictMeteringJson(
      raw,
      maxBytes,
      agentUsageSchema["x-max-json-depth"],
      preparedEnvelope,
    );
  } catch {
    throw new AgentUsageEvidenceError();
  }
}

/** Preserve the published usage2 budget; the HTTP wrapper never enlarges it. */
export function parseAgentUsageJson(raw: Uint8Array) {
  return parseAgentJson(raw, agentUsageSchema["x-max-json-bytes"]);
}

export const MAX_AGENT_EVIDENCE_RESPONSE_BYTES = 98_304;
export function parseAgentEvidenceEnvelopeJson(raw: Uint8Array) {
  return parseAgentJson(raw, MAX_AGENT_EVIDENCE_RESPONSE_BYTES);
}

export const MAX_AGENT_PREPARED_RESPONSE_BYTES =
  3 * MAX_AGENT_EVIDENCE_RESPONSE_BYTES;
export function parseAgentPreparedEnvelopeJson(raw: Uint8Array) {
  return parseAgentJson(raw, MAX_AGENT_PREPARED_RESPONSE_BYTES, true);
}

/** RFC8785 on the finite, validated usage2 value set; never locale-sort keys. */
export function canonicalAgentUsageJson(value: UsageJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalAgentUsageJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalAgentUsageJson(value[key] ?? null)}`,
    )
    .join(",")}}`;
}
