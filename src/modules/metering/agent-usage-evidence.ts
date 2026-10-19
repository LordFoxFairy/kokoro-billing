import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { agentUsageSchema } from "../../generated/agent-usage-v2/schema.gen.js";
import type {
  ModelUsageEvidence,
  TokenUsageV1,
} from "../../generated/agent-usage-v2/types.gen.js";
import { AgentUsageEvidenceError } from "./agent-usage-evidence.error.js";
import {
  canonicalAgentUsageJson,
  parseAgentUsageJson,
} from "./agent-usage-json.js";

export type Frozen<T> = T extends object
  ? { readonly [K in keyof T]: Frozen<T[K]> }
  : T;
export type DecodedAgentUsageEvidence = Readonly<{
  originalJson: string;
  evidence: Frozen<ModelUsageEvidence>;
}>;
export type ExpectedAgentUsageEvidence = Frozen<
  Pick<ModelUsageEvidence, "identity" | "planned" | "revision" | "digest">
>;

type Evidence = Frozen<ModelUsageEvidence>;
const counts = [
  "input_total",
  "output_total",
  "total",
  "input_cache_read",
  "input_cache_write",
  "output_reasoning",
] as const;

const ajv = new Ajv2020({ strict: true, ownProperties: true });
for (const keyword of [
  "x-artifact-version",
  "x-max-json-bytes",
  "x-max-json-depth",
])
  ajv.addKeyword(keyword);
ajv.addKeyword({
  keyword: "x-utf8-max-bytes",
  type: "string",
  schemaType: "number",
  validate: (limit: number, value: string) =>
    Buffer.byteLength(value, "utf8") <= limit,
});
ajv.addKeyword({
  keyword: "x-max-decimal",
  type: "string",
  schemaType: "string",
  validate: (limit: string, value: string) =>
    /^(0|[1-9][0-9]*)$/u.test(value) &&
    value.length <= limit.length &&
    BigInt(value) <= BigInt(limit),
});
ajv.addKeyword({
  keyword: "x-calendar-valid",
  type: "string",
  schemaType: "boolean",
  validate: (_enabled: boolean, value: string) => {
    if (
      !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(
        value,
      )
    )
      return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  },
});
const validate = ajv.compile<ModelUsageEvidence>(agentUsageSchema);

function requireFact(condition: boolean): asserts condition {
  if (!condition) throw new AgentUsageEvidenceError();
}

function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

function validateUsage(usage: Frozen<TokenUsageV1>): void {
  requireFact(counts.every((name) => usage[name].state !== "not_applicable"));
  requireFact(usage.input_cache_write.state === "unreported");
  if (usage.source_protocol === "ollama_openai_chat_completions")
    requireFact(
      usage.input_cache_read.state === "unreported" &&
        usage.output_reasoning.state === "unreported",
    );
  const count = (name: (typeof counts)[number]): bigint | null => {
    const observation = usage[name];
    return observation.state === "reported" ? BigInt(observation.count) : null;
  };
  const input = count("input_total"),
    output = count("output_total"),
    total = count("total");
  let state: "known_zero" | "known_nonzero" | "unknown" = "unknown";
  if (input !== null && output !== null && total !== null) {
    requireFact(input + output === total);
    state = total === 0n ? "known_zero" : "known_nonzero";
  }
  requireFact(usage.totals_state === state);
  for (const [child, parent] of [
    [count("input_cache_read"), input],
    [count("output_reasoning"), output],
  ])
    requireFact(child == null || parent == null || child <= parent);
  requireFact(
    usage.classification_state ===
      (usage.profile_assessment.state === "unsupported" || state === "unknown"
        ? "unknown"
        : "partial"),
  );
}

/** Validated facts only. Neither a price, an authorization nor a settlement receipt. */
export function decodeAgentUsageEvidence(
  raw: Uint8Array,
): DecodedAgentUsageEvidence {
  const parsed = parseAgentUsageJson(raw);
  const value = parsed.value;
  const valid = validate(value);
  validate.errors = null;
  requireFact(valid);
  const evidence = value;
  requireFact(
    evidence.revision === "1"
      ? evidence.predecessor === null
      : evidence.predecessor !== null,
  );
  if (evidence.predecessor !== null)
    requireFact(
      evidence.predecessor.event_id !== evidence.identity.event_id &&
        evidence.predecessor.digest !== evidence.digest,
    );
  const dispatched = evidence.execution.dispatch_started_at !== null;
  requireFact(
    !dispatched || evidence.authorization_observation.state === "granted",
  );
  requireFact(evidence.execution.outcome !== "not_dispatched" || !dispatched);
  requireFact(
    !["completed", "failed"].includes(evidence.execution.outcome) || dispatched,
  );
  if (evidence.usage.state === "normalized") {
    validateUsage(evidence.usage.value);
    requireFact(dispatched);
  }
  const { digest, ...facts } = value;
  const expected = createHash("sha256")
    .update("kokoro-agent:model-usage-evidence:v2\n")
    .update(canonicalAgentUsageJson(facts))
    .digest("hex");
  requireFact(digest === expected);
  return Object.freeze({
    originalJson: parsed.text,
    evidence: freeze(evidence),
  });
}

function same(left: unknown, right: unknown): boolean {
  // Values originate in validated plain/null-prototype JSON, never arbitrary classes.
  return isDeepStrictEqual(left, right, { skipPrototype: true });
}

/** Expected must come from a trusted durable snapshot, never the response being checked. */
export function bindSealedAgentUsageEvidence(
  raw: Uint8Array,
  expected: ExpectedAgentUsageEvidence,
): DecodedAgentUsageEvidence {
  const result = decodeAgentUsageEvidence(raw),
    evidence = result.evidence;
  requireFact(
    evidence.execution.seal &&
      same(evidence.identity, expected.identity) &&
      same(evidence.planned, expected.planned) &&
      evidence.revision === expected.revision &&
      evidence.digest === expected.digest,
  );
  return result;
}

function validateKnowledge(previous: Evidence, incoming: Evidence): void {
  if (previous.usage.raw_usage_digest !== null)
    requireFact(
      previous.usage.raw_usage_digest === incoming.usage.raw_usage_digest,
    );
  if (previous.actual.state === "verified")
    requireFact(same(previous.actual, incoming.actual));
  if (previous.execution.outcome !== "unknown")
    requireFact(previous.execution.outcome === incoming.execution.outcome);
  requireFact(
    previous.execution.prepared_at === incoming.execution.prepared_at,
  );
  if (previous.execution.dispatch_started_at !== null)
    requireFact(
      previous.execution.dispatch_started_at ===
        incoming.execution.dispatch_started_at,
    );
  requireFact(!previous.execution.seal || incoming.execution.seal);
  const before = previous.authorization_observation,
    after = incoming.authorization_observation;
  if (before.state === "granted" || before.state === "denied")
    requireFact(same(before, after));
  if (before.state === "requested_unknown")
    requireFact(
      after.state !== "not_requested" &&
        before.request_ref === after.request_ref,
    );
  if (previous.usage.state === "normalized") {
    requireFact(incoming.usage.state === "normalized");
    const before = previous.usage.value,
      after = incoming.usage.value;
    requireFact(same(before.profile_assessment, after.profile_assessment));
    for (const key of [
      "profile_id",
      "source_protocol",
      "aggregation_mode",
      "unit",
    ] as const)
      requireFact(before[key] === after[key]);
    for (const key of counts)
      if (before[key].state === "reported")
        requireFact(same(before[key], after[key]));
  }
}

export function verifyAgentUsageSuccessor(
  previousRaw: Uint8Array,
  incomingRaw: Uint8Array,
): DecodedAgentUsageEvidence {
  const previous = decodeAgentUsageEvidence(previousRaw).evidence;
  const result = decodeAgentUsageEvidence(incomingRaw),
    incoming = result.evidence;
  const { event_id: previousEvent, ...previousIdentity } = previous.identity;
  const { event_id: incomingEvent, ...incomingIdentity } = incoming.identity;
  requireFact(
    same(previousIdentity, incomingIdentity) &&
      same(previous.planned, incoming.planned),
  );
  if (previous.revision === incoming.revision) {
    requireFact(same(previous, incoming));
    return result;
  }
  requireFact(BigInt(incoming.revision) === BigInt(previous.revision) + 1n);
  requireFact(
    incoming.predecessor !== null &&
      incoming.predecessor.event_id === previousEvent &&
      incoming.predecessor.digest === previous.digest &&
      incomingEvent !== previousEvent,
  );
  validateKnowledge(previous, incoming);
  return result;
}
