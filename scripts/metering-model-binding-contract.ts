import { createHash } from "node:crypto";
const baselineSha =
  "8005cff204976ca681653565fb8b6b098bc195cc70049743f70ae85989df35ab";
const modelRevisionProperty =
  "        model_revision:\n          type: object\n          additionalProperties: false\n          required:\n            - id\n            - content_digest\n          properties:\n            id:\n              type: string\n              format: uuid\n              pattern: ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\\s\\S])\n            content_digest:\n              type: string\n              pattern: ^[0-9a-f]{64}$(?![\\s\\S])\n";
/** Build-only inverse proof; runtime has no reader for an unbound rate. */
export function meteringModelBindingBaselineSource(source: string): string {
  if (!source.includes("version: 4.0.0-experimental.6"))
    throw new Error("Invalid metering model-binding publication");
  const start = source.indexOf("    MeteringRate:\n"),
    end = source.indexOf("    MeteringRateConfiguration:", start);
  const current = source.slice(start, end);
  if (
    start < 0 ||
    end <= start ||
    !current.includes("        - model_revision\n") ||
    !current.includes(modelRevisionProperty)
  )
    throw new Error("Invalid exact model revision binding");
  const previous = current
    .replace("        - model_revision\n", "")
    .replace(modelRevisionProperty, "");
  const baseline = (
    source.slice(0, start) +
    previous +
    source.slice(end)
  ).replace("version: 4.0.0-experimental.6", "version: 4.0.0-experimental.5");
  if (createHash("sha256").update(baseline).digest("hex") !== baselineSha)
    throw new Error("Billing previous complete canonical changed");
  return baseline;
}
