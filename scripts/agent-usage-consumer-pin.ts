import { createHash } from "node:crypto";

// Accepted from the immutable Agent 2d5ce12 Git objects, not the live checkout.
// This is a release pointer, never a runtime credential or financial permit.
export const AGENT_USAGE_SCHEMA_VERSION = "2.0.0";
export const AGENT_USAGE_SCHEMA_SHA256 =
  "552f0d22251837aaf4d83766c7bd91311984f707f9a42950ed53ac7127bb5504";
const CONSUMER_PIN_SHA256 =
  "e9c53c2bff90add8f8afab18162571a86c339388e6824fc6101de134a5553014";

export function assertAgentUsageConsumerPin(bytes: Uint8Array): void {
  if (
    bytes.byteLength > 8192 ||
    createHash("sha256").update(bytes).digest("hex") !== CONSUMER_PIN_SHA256
  )
    throw new Error("Agent usage consumer pin differs from accepted release");
}
