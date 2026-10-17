import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertAgentUsageConsumerPin } from "./agent-usage-consumer-pin.js";

/** Owner bytes are accepted only through the existing immutable release receipt. */
export async function readAgentEvidenceHttpArtifacts(
  root: string,
  pin: Uint8Array,
) {
  assertAgentUsageConsumerPin(pin);
  const receipt = z
    .object({
      http_contract: z.object({
        version: z.string(),
        sha256: z.string(),
        provenance_sha256: z.string(),
      }),
    })
    .parse(JSON.parse(Buffer.from(pin).toString("utf8")));
  let source = "";
  for (const [name, digest] of [
    ["openapi", receipt.http_contract.sha256],
    ["provenance", receipt.http_contract.provenance_sha256],
  ] as const) {
    const raw = await readFile(join(root, `vendor/agent/http/v6/${name}.json`));
    if (createHash("sha256").update(raw).digest("hex") !== digest)
      throw new Error(
        "Agent HTTP distributed artifact differs from accepted release",
      );
    if (name === "openapi") source = raw.toString("utf8");
  }
  const document = z
    .object({
      info: z.object({ version: z.literal(receipt.http_contract.version) }),
      components: z.object({ schemas: z.record(z.unknown()) }),
    })
    .parse(JSON.parse(source));
  const schemas = Object.fromEntries(
    [
      "FinalModelCallUsageEvidenceEnvelope",
      "FinalModelCallUsageEvidence",
      "Meta",
    ].map((name) => {
      const value = document.components.schemas[name];
      if (!value || typeof value !== "object")
        throw new Error("Agent HTTP evidence schema is absent");
      return [name, value];
    }),
  );
  return { schemas, sha256: receipt.http_contract.sha256 };
}
