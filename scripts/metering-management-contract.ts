import { meteringModelBindingBaselineSource } from "./metering-model-binding-contract.js";
import { createHash } from "node:crypto";
import { parse } from "yaml";

const precedingSha =
  "a09e00a3d6f602fdaff13a50a5a839c8a989b1a26ab28c43eac314738fcfdef2";
const profileSha =
  "546cbc1857f7b44a46525150ab2a11ef2b55865bd28bfb757c7fc03fd7f7cae7";
export const meteringManagementSchemas = [
  "MeteringRational",
  "MeteringRate",
  "MeteringRateConfiguration",
  "MeteringPolicyConfiguration",
  "AdminMeteringRatePublishRequest",
  "AdminMeteringPolicyPublishRequest",
  "MeteringPublication",
  "MeteringPublicationResponse",
  "MeteringRateRevision",
  "MeteringPolicyRevision",
  "AdminMeteringPricingResponse",
] as const;
const paths = [
  "/v1/admin/billing/metering/pricing",
  "/v1/admin/billing/metering/rate-revisions",
  "/v1/admin/billing/metering/policy-revisions",
];
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
/** Build/test-only exact inverse. There is no runtime old contract reader. */
export function meteringManagementBaselineSource(
  currentSource: string,
): string {
  const source = meteringModelBindingBaselineSource(currentSource);
  const doc = parse(source) as {
    info?: { version?: string };
    paths?: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
  };
  const profile = {
    paths: Object.fromEntries(paths.map((path) => [path, doc.paths?.[path]])),
    schemas: Object.fromEntries(
      meteringManagementSchemas.map((name) => [
        name,
        doc.components?.schemas?.[name],
      ]),
    ),
  };
  if (
    doc.info?.version !== "4.0.0-experimental.5" ||
    createHash("sha256")
      .update(JSON.stringify(stable(profile)))
      .digest("hex") !== profileSha
  )
    throw new Error("Invalid metering management contract");
  const preceding = source
    .replace("version: 4.0.0-experimental.5", "version: 4.0.0-experimental.4")
    .replace(
      /^ {2}\/v1\/admin\/billing\/metering\/pricing:\n[\s\S]*?(?=^ {2}\/v1\/admin\/billing\/credit-grants:\n)/mu,
      "",
    )
    .replace(
      /^ {4}MeteringRational:\n[\s\S]*?(?=^ {4}AdminCreditGrantRequest:\n)/mu,
      "",
    );
  if (createHash("sha256").update(preceding).digest("hex") !== precedingSha)
    throw new Error("Billing preceding canonical bytes changed");
  return preceding;
}
