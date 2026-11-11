import { createHash } from "node:crypto";
import { parse } from "yaml";

// Build/test invariant only: one editable canonical source, no runtime old-wire fallback.
const BASELINE =
  "f934d6f81842fafaec2e3e64cca6bd4669f86601979bd737941a5695506814fe";
const FUNDING_PROFILE =
  "084d9726435aaf544faf1b0b8aa24402ad4d155f2120fd1c333cb780359908b0";
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, stable(object[key])]),
    );
  }
  return value;
}
export function creditFundingBaselineSource(source: string): string {
  const doc = parse(source) as {
    info?: { version?: string };
    paths?: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
  };
  const profile = {
    path: doc.paths?.["/v1/admin/billing/credit-grants"],
    request: doc.components?.schemas?.AdminCreditGrantRequest,
    response: doc.components?.schemas?.AdminCreditGrantResponse,
  };
  if (
    doc.info?.version !== "4.0.0-experimental.4" ||
    createHash("sha256")
      .update(JSON.stringify(stable(profile)))
      .digest("hex") !== FUNDING_PROFILE
  )
    throw new Error("Invalid administrative credit grant contract");
  const baseline = source
    .replace("version: 4.0.0-experimental.4", "version: 4.0.0-experimental.3")
    .replace(
      /^ {2}\/v1\/admin\/billing\/credit-grants:\n[\s\S]*?(?=^ {2}\/v1\/admin\/billing\/refunds:\n)/mu,
      "",
    )
    .replace(/^ {4}AdminCreditGrantRequest:\n[\s\S]*?(?=^ {4}Uuid:\n)/mu, "");
  if (createHash("sha256").update(baseline).digest("hex") !== BASELINE)
    throw new Error("Billing preceding canonical bytes changed");
  return baseline;
}
