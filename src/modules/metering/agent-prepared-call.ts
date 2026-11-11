import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import { z } from "zod";
import { agentPreparedEnvelopeSchema } from "../../generated/agent-usage-v2/prepared-http-schema.gen.js";
import { agentUsageSchema } from "../../generated/agent-usage-v2/schema.gen.js";
import type { PreparedModelCallSnapshotEnvelope } from "../../generated/agent-usage-v2/evidence-http.gen.js";
import type {
  AuthorizationRequested,
  EvidenceIdentity,
  PlannedBinding,
} from "../../generated/agent-usage-v2/types.gen.js";
import { createAgentUsageAjv } from "./agent-usage-schema.js";
import {
  canonicalAgentUsageJson,
  parseAgentPreparedEnvelopeJson,
  parseAgentUsageJson,
} from "./agent-usage-json.js";
import { freezeAgentUsageFacts } from "./agent-usage-evidence.js";
import type { Frozen } from "./agent-usage-evidence.js";
import { AgentUsageReaderError } from "./agent-usage-evidence-reader.error.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const opaque = z
  .string()
  .min(1)
  .max(512)
  .refine((value) =>
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127 && (point < 0xd800 || point > 0xdfff);
    }),
  );
const expectedSchema = z
  .object({
    tenantId: z.string().regex(/^[\x21-\x7e]{1,255}$/u),
    runId: opaque,
    attemptId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
    requestRef: opaque,
    attemptBindingDigest: digest,
    plannedDigest: digest,
    finalRequestDigest: digest,
  })
  .strict();
export type ExpectedPreparedModelCall = Readonly<
  z.infer<typeof expectedSchema>
>;
export function copyPreparedExpectation(
  value: ExpectedPreparedModelCall,
): ExpectedPreparedModelCall {
  const parsed = expectedSchema.safeParse(structuredClone(value));
  if (!parsed.success) throw new AgentUsageReaderError("REQUEST_INVALID");
  return Object.freeze(parsed.data);
}
export type PreparedCallIdentity = Omit<EvidenceIdentity, "event_id">;
export type DecodedPreparedModelCall = Frozen<{
  identity: PreparedCallIdentity;
  planned: PlannedBinding;
  authorization: AuthorizationRequested;
  attemptBindingDigest: string;
  plannedDigest: string;
  finalRequestDigest: string;
  preparedAt: string;
  observedAt: string;
  leaseExpiresAt: string;
  original: {
    attemptBindingJson: string;
    plannedJson: string;
    authorizationJson: string;
  };
}>;
const httpAjv = new Ajv2020({ strict: true, ownProperties: true });
formatsModule.default(httpAjv);
const validateEnvelope = httpAjv.compile<PreparedModelCallSnapshotEnvelope>(
  agentPreparedEnvelopeSchema,
);
const ajv = createAgentUsageAjv();
const identityDefinition = agentUsageSchema.$defs.EvidenceIdentity;
const validateIdentity = ajv.compile<PreparedCallIdentity>({
  ...identityDefinition,
  $defs: agentUsageSchema.$defs,
  required: identityDefinition.required.filter((name) => name !== "event_id"),
  properties: Object.fromEntries(
    Object.entries(identityDefinition.properties).filter(
      ([name]) => name !== "event_id",
    ),
  ),
});
const validatePlanned = ajv.compile<PlannedBinding>({
  $defs: agentUsageSchema.$defs,
  $ref: "#/$defs/PlannedBinding",
});
const validateAuthorization = ajv.compile<AuthorizationRequested>({
  $defs: agentUsageSchema.$defs,
  $ref: "#/$defs/AuthorizationRequested",
});
function invalid(): never {
  throw new AgentUsageReaderError("CONTRACT_INVALID");
}
function decodeCanonical<T>(
  encoded: string,
  expectedDigest: string,
  validate: ValidateFunction<T>,
): Readonly<{ value: T; originalJson: string }> {
  const raw = Buffer.from(encoded, "base64url");
  if (
    raw.toString("base64url") !== encoded ||
    createHash("sha256").update(raw).digest("hex") !== expectedDigest
  )
    invalid();
  const parsed = parseAgentUsageJson(raw);
  const valid = validate(parsed.value);
  validate.errors = null;
  if (!valid || canonicalAgentUsageJson(parsed.value) !== parsed.text)
    invalid();
  return { value: parsed.value, originalJson: parsed.text };
}
/** Strict current first-admission facts only, never a dispatch or financial permit. */
export function decodeAgentPreparedResponse(
  raw: Uint8Array,
  expected: ExpectedPreparedModelCall,
  requestId: string,
): DecodedPreparedModelCall {
  try {
    const value = parseAgentPreparedEnvelopeJson(raw).value;
    const valid = validateEnvelope(value);
    validateEnvelope.errors = null;
    if (!valid) invalid();
    const { data, meta } = value;
    if (
      meta.request_id !== requestId ||
      data.binding_version !== "2.0.0" ||
      data.status !== "authorization_pending" ||
      data.attempt_id !== expected.attemptId ||
      data.attempt_binding_digest !== expected.attemptBindingDigest ||
      data.planned_digest !== expected.plannedDigest ||
      data.final_request_digest !== expected.finalRequestDigest
    )
      invalid();
    const identity = decodeCanonical(
      data.attempt_binding_bytes_base64url,
      data.attempt_binding_digest,
      validateIdentity,
    );
    const planned = decodeCanonical(
      data.planned_bytes_base64url,
      data.planned_digest,
      validatePlanned,
    );
    const authorization = decodeCanonical(
      data.authorization_bytes_base64url,
      data.authorization_digest,
      validateAuthorization,
    );
    if (
      identity.value.tenant_ref !== expected.tenantId ||
      identity.value.run_id !== expected.runId ||
      identity.value.attempt_id !== expected.attemptId ||
      authorization.value.state !== "requested_unknown" ||
      authorization.value.request_ref !== expected.requestRef
    )
      invalid();
    if (
      Date.parse(data.prepared_at) > Date.parse(data.observed_at) ||
      Date.parse(data.observed_at) >= Date.parse(data.lease_expires_at)
    )
      invalid();
    if (Date.parse(data.lease_expires_at) <= Date.now())
      throw new AgentUsageReaderError("PREPARATION_UNAVAILABLE");
    return freezeAgentUsageFacts({
      identity: identity.value,
      planned: planned.value,
      authorization: authorization.value,
      attemptBindingDigest: data.attempt_binding_digest,
      plannedDigest: data.planned_digest,
      finalRequestDigest: data.final_request_digest,
      preparedAt: data.prepared_at,
      observedAt: data.observed_at,
      leaseExpiresAt: data.lease_expires_at,
      original: {
        attemptBindingJson: identity.originalJson,
        plannedJson: planned.originalJson,
        authorizationJson: authorization.originalJson,
      },
    });
  } catch (error) {
    if (error instanceof AgentUsageReaderError) throw error;
    return invalid();
  }
}

/** Same fixed schema/canonical checks, without a live prepared-envelope/lease requirement. */
export function decodeStoredPreparedBinding(
  input: Readonly<{
    attemptBindingJson: string;
    attemptBindingDigest: string;
    plannedJson: string;
    plannedDigest: string;
  }>,
): Frozen<{ identity: PreparedCallIdentity; planned: PlannedBinding }> {
  return freezeAgentUsageFacts({
    identity: decodeCanonical(
      Buffer.from(input.attemptBindingJson).toString("base64url"),
      input.attemptBindingDigest,
      validateIdentity,
    ).value,
    planned: decodeCanonical(
      Buffer.from(input.plannedJson).toString("base64url"),
      input.plannedDigest,
      validatePlanned,
    ).value,
  });
}
