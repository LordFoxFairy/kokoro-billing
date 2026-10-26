import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentModelCallBound } from "../../generated/agent-model-call-bound-v1/index.js";
import { agentModelCallBoundSchema } from "../../generated/agent-model-call-bound-v1/schema.gen.js";
import {
  agentCapacityGuarantee,
  agentCapacityManifest,
} from "../../generated/agent-model-call-bound-v1/capacity-guarantee.gen.js";
import {
  agentUsageSchema,
  SOURCE_SHA256 as usageDigest,
} from "../../generated/agent-usage-v2/schema.gen.js";
import type { PlannedBinding } from "../../generated/agent-usage-v2/types.gen.js";
import type { Frozen } from "./agent-usage-evidence.js";
import { createAgentModelCallValidator } from "./agent-model-call-validation.js";
import { AgentModelCallBoundError } from "./agent-model-call-bound.error.js";
import {
  canonicalAgentBoundJson,
  canonicalAgentUsageJson,
  parseAgentBoundJson,
  parseAgentUsageJson,
} from "./agent-usage-json.js";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const attempt = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const opaque = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value) <= 512 &&
      ![...value].some((char) => {
        const point = char.codePointAt(0) ?? 0;
        return (
          point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff)
        );
      }),
  );
const expectedSchema = z
  .object({
    tenantRef: z.string().regex(/^[\x21-\x7e]{1,255}$/u),
    producer: z.literal("kokoro-agent"),
    runId: opaque,
    callId: uuid,
    attemptId: attempt,
    attemptOrdinal: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/u)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
    featureKey: opaque,
    plannedBindingRef: z.string(),
    plannedBindingDigest: digest,
    usageProfileVersion: z.literal("2.0.0"),
    usageProfileDigest: z.literal(usageDigest),
    executionBoundRef: z.string(),
    executionBoundDigest: digest,
  })
  .strict()
  .refine(
    (value) =>
      value.plannedBindingRef === `mpb_${value.attemptId}` &&
      value.executionBoundRef === `mcb_${value.attemptId}`,
  );

export type ExpectedAgentModelCallBound = Readonly<
  z.infer<typeof expectedSchema>
>;
export type DecodedAgentModelCallBound = Readonly<{
  originalPlannedJson: string;
  originalBoundJson: string;
  planned: Frozen<PlannedBinding>;
  bound: Frozen<AgentModelCallBound>;
}>;

/** Snapshot only trusted caller input, before any network suspension. */
export function snapshotExpectedAgentModelCallBound(
  value: ExpectedAgentModelCallBound,
): ExpectedAgentModelCallBound {
  return Object.freeze(expectedSchema.parse(structuredClone(value)));
}

const ajv = createAgentModelCallValidator();
const validateBound = ajv.compile<AgentModelCallBound>(
  agentModelCallBoundSchema,
);
const validatePlanned = ajv.compile<PlannedBinding>({
  ...agentUsageSchema,
  $id: "urn:kokoro-billing:planned-binding-consumer",
  $ref: "#/$defs/PlannedBinding",
});

function requireFact(value: boolean): asserts value {
  if (!value) throw new AgentModelCallBoundError();
}
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

/** Authenticate exact owner facts; this returns neither permission nor a price. */
export function decodeAgentModelCallBound(
  input: Readonly<{
    plannedRaw: Uint8Array;
    boundRaw: Uint8Array;
    expected: ExpectedAgentModelCallBound;
    now: number;
  }>,
): DecodedAgentModelCallBound {
  try {
    const planned = parseAgentUsageJson(input.plannedRaw),
      bound = parseAgentBoundJson(input.boundRaw);
    requireFact(
      canonicalAgentUsageJson(planned.value) === planned.text &&
        canonicalAgentBoundJson(bound.value) === bound.text,
    );
    // Ajv object-const equality expects ordinary objects. structuredClone keeps
    // the parser's own keys (including special names) without invoking setters.
    const boundValue: unknown = structuredClone(bound.value);
    const plannedValid = validatePlanned(planned.value),
      boundValid = validateBound(boundValue);
    validatePlanned.errors = null;
    validateBound.errors = null;
    requireFact(plannedValid && boundValid);
    const p = planned.value,
      b = boundValue,
      e = input.expected;
    requireFact(
      createHash("sha256").update(input.plannedRaw).digest("hex") ===
        e.plannedBindingDigest &&
        createHash("sha256").update(input.boundRaw).digest("hex") ===
          e.executionBoundDigest &&
        b.planned_binding_digest === e.plannedBindingDigest &&
        b.execution_bound_ref === e.executionBoundRef &&
        b.planned_binding_ref === e.plannedBindingRef &&
        b.attempt_id === e.attemptId &&
        b.call_id === e.callId &&
        b.attempt_ordinal === e.attemptOrdinal &&
        b.tenant_ref === e.tenantRef &&
        b.producer === e.producer &&
        b.run_id === e.runId &&
        b.execution_bound_ref === `mcb_${b.attempt_id}` &&
        b.planned_binding_ref === `mpb_${b.attempt_id}` &&
        p.feature_key === e.featureKey &&
        p.binding_version === e.usageProfileVersion &&
        e.usageProfileDigest === usageDigest &&
        p.request_model === agentCapacityGuarantee.request_model &&
        p.provider_model_name === agentCapacityGuarantee.request_model &&
        b.capacity_guarantee_digest ===
          agentCapacityManifest.guarantee_sha256 &&
        b.capacity_guarantee_id === agentCapacityGuarantee.guarantee_id &&
        b.profile_id === agentCapacityGuarantee.profile_id &&
        BigInt(b.total_tokens_max) ===
          BigInt(b.prompt_tokens_max) + BigInt(b.output_tokens_max) &&
        BigInt(b.output_tokens_max) <=
          BigInt(agentCapacityGuarantee.max_output_tokens),
    );
    const sealed = Date.parse(b.sealed_at),
      expiry = Date.parse(b.valid_until);
    requireFact(
      Number.isFinite(input.now) &&
        sealed <= input.now &&
        input.now < expiry &&
        sealed < expiry &&
        expiry <= Date.parse(agentCapacityGuarantee.sunset),
    );
    return Object.freeze({
      originalPlannedJson: planned.text,
      originalBoundJson: bound.text,
      planned: freeze<PlannedBinding>(p),
      bound: freeze<AgentModelCallBound>(b),
    });
  } catch {
    throw new AgentModelCallBoundError();
  }
}
