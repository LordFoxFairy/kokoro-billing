import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MeteringPolicyRevisionDraft,
  MeteringRevisionReference,
} from "./metering-pricing-revision.types.js";

/** Exact owner-published bytes, not the Agent aggregate or a schema digest. */
const POLICY_SHA256 =
  "8d8dbe5950cfaa7f1383f847ad6e270c62bbd67bf02ea8717ac8d360594cb076";
const AGENT_USAGE_SHA256 =
  "ecd30d1908f410eed29181c9f52669f824312bf3a2e3874153d990b95fe58b91";

export function verifyMeteringPolicyArtifact(
  bytes: Uint8Array,
): MeteringRevisionReference {
  if (createHash("sha256").update(bytes).digest("hex") !== POLICY_SHA256)
    throw new TypeError("Unsupported metering policy artifact");
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid metering policy artifact");
  const expected = {
    artifact_version: "1.0.0",
    completed: "capture_verified_actual_only",
    failed_or_cancelled: "capture_verified_actual_only",
    not_dispatched: "release_confirmed_unused",
    unknown_or_incomplete: "pending_reconciliation",
  };
  if (
    Reflect.ownKeys(value).length !== 5 ||
    Object.entries(expected).some(
      ([key, literal]) => Reflect.get(value, key) !== literal,
    )
  )
    throw new TypeError("Invalid metering policy artifact");
  return Object.freeze({ version: "1.0.0", artifactDigest: POLICY_SHA256 });
}

export function assertExecutableMeteringPolicy(
  draft: MeteringPolicyRevisionDraft,
): void {
  const reference = verifyMeteringPolicyArtifact(
    readFileSync(resolve("contract/metering-policy/v1/policy.json")),
  );
  if (
    draft.profileRef.version !== "1.0.0" ||
    draft.profileRef.artifactDigest !== AGENT_USAGE_SHA256 ||
    draft.failurePolicyRef?.version !== reference.version ||
    draft.failurePolicyRef.artifactDigest !== reference.artifactDigest ||
    BigInt(draft.multiplier.numerator) <= 0n ||
    BigInt(draft.creditMicrosPerMinor.numerator) <= 0n
  )
    throw new TypeError("Nonexecutable metering policy revision");
}
