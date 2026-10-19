import { createClient } from "@hey-api/openapi-ts";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { z } from "zod";
import {
  assertAgentUsageConsumerPin,
  AGENT_USAGE_SCHEMA_SHA256,
} from "./agent-usage-consumer-pin.js";
import { billingApiGenerator } from "./billing-api-artifacts.js";
import { readAgentEvidenceHttpArtifacts } from "./agent-evidence-http-artifacts.js";

const artifactNames = [
  "index.ts",
  "types.gen.ts",
  "schema.gen.ts",
  "evidence-http.gen.ts",
  "evidence-http-schema.gen.ts",
] as const;
const release = z.object({
  usage_artifact: z.object({
    schema_sha256: z.string(),
    vectors_sha256: z.string(),
    manifest_sha256: z.string(),
  }),
});

/** Consume immutable owner bytes, never the live Agent checkout. */
export async function readAgentUsageArtifacts(root: string) {
  const pin = await readFile(
    join(root, "contract/agent/usage/v2/consumer-pin.json"),
  );
  assertAgentUsageConsumerPin(pin);
  const receipt = release.parse(JSON.parse(pin.toString("utf8")));
  let schema = "";
  for (const name of ["schema", "vectors", "manifest"] as const) {
    const bytes = await readFile(
      join(root, `vendor/agent/usage/v2/${name}.json`),
    );
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      receipt.usage_artifact[`${name}_sha256`]
    )
      throw new Error(
        "Agent usage distributed artifact differs from accepted release",
      );
    if (name === "schema") schema = bytes.toString("utf8");
  }
  return { schema, http: await readAgentEvidenceHttpArtifacts(root, pin) };
}

export async function generateAgentUsageArtifacts(
  root: string,
  check: boolean,
): Promise<void> {
  const { schema, http } = await readAgentUsageArtifacts(root);
  for (const [name, version] of [
    ["@hey-api/openapi-ts", billingApiGenerator.version],
    ["prettier", billingApiGenerator.formatter.version],
  ]) {
    const installed = z
      .object({ version: z.literal(version) })
      .safeParse(
        JSON.parse(
          await readFile(
            join(root, "node_modules", name ?? "", "package.json"),
            "utf8",
          ),
        ),
      );
    if (!installed.success)
      throw new Error("Agent usage generator toolchain drift");
  }
  const source = z
    .object({ $defs: z.record(z.unknown()) })
    .parse(
      JSON.parse(schema.replaceAll('"#/$defs/', '"#/components/schemas/')),
    );
  const scratch = await mkdtemp(join(tmpdir(), "kokoro-agent-usage-"));
  try {
    const input = join(scratch, "input.json");
    const output = join(scratch, "output");
    await writeFile(
      input,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Agent usage2 distributed artifact", version: "2.0.0" },
        paths: {},
        components: { schemas: source.$defs },
      }),
    );
    await createClient({
      input,
      logs: { level: "silent", file: false },
      output: { path: output, importFileExtension: ".js" },
      plugins: [{ name: "@hey-api/typescript" }],
    });
    const httpInput = join(scratch, "http.json");
    const httpOutput = join(scratch, "http-output");
    await writeFile(
      httpInput,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Agent HTTP6 exact evidence", version: "6.0.0" },
        paths: {},
        components: { schemas: http.schemas },
      }),
    );
    await createClient({
      input: httpInput,
      logs: { level: "silent", file: false },
      output: { path: httpOutput, importFileExtension: ".js" },
      plugins: [{ name: "@hey-api/typescript" }],
    });
    const envelopeSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/FinalModelCallUsageEvidenceEnvelope",
      $defs: JSON.parse(
        JSON.stringify(http.schemas).replaceAll(
          '"#/components/schemas/',
          '"#/$defs/',
        ),
      ) as unknown,
    };
    const httpSchema = `// Generated from immutable Agent HTTP6 schema. Do not edit.\nexport const SOURCE_SHA256 = ${JSON.stringify(http.sha256)};\nexport const agentEvidenceEnvelopeSchema = ${JSON.stringify(envelopeSchema)} as const;\n`;
    const rawSchema = `// Generated from immutable Agent usage2 schema. Do not edit.\nexport const SOURCE_SHA256 = ${JSON.stringify(AGENT_USAGE_SCHEMA_SHA256)};\nexport const agentUsageSchema = ${schema.trim()} as const;\n`;
    const files = {
      "index.ts": await readFile(join(output, "index.ts"), "utf8"),
      "types.gen.ts": await readFile(join(output, "types.gen.ts"), "utf8"),
      "schema.gen.ts": rawSchema,
      "evidence-http.gen.ts": await readFile(
        join(httpOutput, "types.gen.ts"),
        "utf8",
      ),
      "evidence-http-schema.gen.ts": httpSchema,
    };
    const destination = join(root, "src/generated/agent-usage-v2");
    if (!check) await mkdir(destination, { recursive: true });
    const existing = await readdir(destination);
    if (
      existing.some(
        (name) => !artifactNames.some((allowed) => allowed === name),
      ) ||
      (check && existing.length !== artifactNames.length)
    )
      throw new Error("Agent usage unexpected generated file inventory");
    const prettier = JSON.parse(
      await readFile(join(root, ".prettierrc.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const name of artifactNames) {
      const generated = await format(files[name], {
        ...prettier,
        parser: "typescript",
      });
      if (check) {
        if ((await readFile(join(destination, name), "utf8")) !== generated)
          throw new Error("Agent usage generated artifact drift");
      } else await writeFile(join(destination, name), generated);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw new Error("Usage: generate-agent-usage.ts [--check]");
  await generateAgentUsageArtifacts(
    resolve(import.meta.dirname, ".."),
    args[0] === "--check",
  );
}
