import { createClient } from "@hey-api/openapi-ts";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
const boundArtifactNames = [
  "index.ts",
  "types.gen.ts",
  "schema.gen.ts",
  "bound-http.gen.ts",
  "bound-http-schema.gen.ts",
  "capacity-guarantee.gen.ts",
] as const;
const release = z.object({
  usage_artifact: z.object({
    schema_sha256: z.string(),
    vectors_sha256: z.string(),
    manifest_sha256: z.string(),
  }),
  bound_artifact: z.record(z.string()),
  capacity_guarantee_artifact: z.record(z.string()),
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
  const bound: Record<string, unknown> = {};
  const capacity: Record<string, unknown> = {};
  for (const [group, folder, target, names] of [
    [
      receipt.bound_artifact,
      "model-call-bound",
      bound,
      ["schema", "vectors", "manifest"],
    ],
    [
      receipt.capacity_guarantee_artifact,
      "model-call-capacity-guarantee",
      capacity,
      ["schema", "guarantee", "evidence", "vectors", "manifest"],
    ],
  ] as const) {
    for (const name of names) {
      const bytes = await readFile(
        join(root, `vendor/agent/${folder}/v1/${name}.json`),
      );
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        group[`${name}_sha256`]
      )
        throw new Error(
          "Agent bound distributed artifact differs from accepted release",
        );
      target[name] = JSON.parse(bytes.toString("utf8")) as unknown;
    }
  }
  return {
    schema,
    bound,
    capacity,
    receipt,
    http: await readAgentEvidenceHttpArtifacts(root, pin),
  };
}

export async function generateAgentUsageArtifacts(
  root: string,
  check: boolean,
): Promise<void> {
  const { schema, http, bound, capacity, receipt } =
    await readAgentUsageArtifacts(root);
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
        info: { title: "Agent HTTP7.1 exact evidence", version: "7.1.0" },
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
    const httpSchema = `// Generated from immutable Agent HTTP7.1 schema. Do not edit.\nexport const SOURCE_SHA256 = ${JSON.stringify(http.sha256)};\nexport const agentEvidenceEnvelopeSchema = ${JSON.stringify(envelopeSchema)} as const;\n`;
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
    const boundSource = z
      .object({ $defs: z.record(z.unknown()) })
      .passthrough()
      .parse(bound.schema);
    const boundInput = join(scratch, "bound.json");
    const boundOutput = join(scratch, "bound-output");
    const { $defs, ...boundRoot } = boundSource;
    await writeFile(
      boundInput,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Agent model call bound", version: "1.0.0" },
        paths: {},
        components: {
          schemas: JSON.parse(
            JSON.stringify({
              ...$defs,
              AgentModelCallBound: boundRoot,
            }).replaceAll('"#/$defs/', '"#/components/schemas/'),
          ) as unknown,
        },
      }),
    );
    await createClient({
      input: boundInput,
      logs: { level: "silent", file: false },
      output: { path: boundOutput, importFileExtension: ".js" },
      plugins: [{ name: "@hey-api/typescript" }],
    });
    const boundHttpInput = join(scratch, "bound-http.json"),
      boundHttpOutput = join(scratch, "bound-http-output");
    await writeFile(
      boundHttpInput,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Agent bound HTTP7.1", version: "7.1.0" },
        paths: {},
        components: { schemas: http.boundSchemas },
      }),
    );
    await createClient({
      input: boundHttpInput,
      logs: { level: "silent", file: false },
      output: { path: boundHttpOutput, importFileExtension: ".js" },
      plugins: [{ name: "@hey-api/typescript" }],
    });
    const boundHttpDefs: unknown = JSON.parse(
      JSON.stringify(http.boundSchemas).replaceAll(
        '"#/components/schemas/',
        '"#/$defs/',
      ),
    );
    const boundFiles = {
      "index.ts": await readFile(join(boundOutput, "index.ts"), "utf8"),
      "types.gen.ts": await readFile(join(boundOutput, "types.gen.ts"), "utf8"),
      "schema.gen.ts": `// Generated from immutable Agent bound schema. Do not edit.\nexport const SOURCE_SHA256 = ${JSON.stringify(receipt.bound_artifact.schema_sha256)};\nexport const agentModelCallBoundSchema = ${JSON.stringify(bound.schema)} as const;\n`,
      "bound-http.gen.ts": await readFile(
        join(boundHttpOutput, "types.gen.ts"),
        "utf8",
      ),
      "bound-http-schema.gen.ts": `// Generated from immutable Agent HTTP7.1 schema. Do not edit.\nexport const SOURCE_SHA256 = ${JSON.stringify(http.sha256)};\nexport const agentBoundHttpSchemas = ${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $defs: boundHttpDefs })} as const;\nexport const agentBoundHttpErrorCodes = ${JSON.stringify(http.errors)} as const;\n`,
      "capacity-guarantee.gen.ts": `// Generated from immutable Agent capacity release. Do not edit.\nexport const agentCapacityGuarantee = ${JSON.stringify(capacity.guarantee)} as const;\nexport const agentCapacityManifest = ${JSON.stringify(capacity.manifest)} as const;\nexport const SOURCE_DIGESTS = ${JSON.stringify(receipt.capacity_guarantee_artifact)} as const;\n`,
    };
    const boundDestination = join(
      root,
      "src/generated/agent-model-call-bound-v1",
    );
    if (!check) await mkdir(boundDestination, { recursive: true });
    const boundExisting = await readdir(boundDestination);
    if (
      boundExisting.some(
        (name) => !boundArtifactNames.some((allowed) => allowed === name),
      ) ||
      (check && boundExisting.length !== boundArtifactNames.length)
    )
      throw new Error("Agent bound unexpected generated file inventory");
    for (const name of boundArtifactNames) {
      const generated = await format(boundFiles[name], {
        ...prettier,
        parser: "typescript",
      });
      if (check) {
        if (
          (await readFile(join(boundDestination, name), "utf8")) !== generated
        )
          throw new Error("Agent bound generated artifact drift");
      } else await writeFile(join(boundDestination, name), generated);
    }
  } finally {
    await rename(scratch, join(homedir(), ".Trash", basename(scratch)));
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
