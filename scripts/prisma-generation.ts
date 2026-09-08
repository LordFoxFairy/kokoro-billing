import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  GENERATED_PROVENANCE,
  GENERATED_SCHEMA,
} from "./prisma-generation.constants.js";
import type { PrismaProvenance } from "./prisma-generation.types.js";
import { runPrisma } from "./prisma-process.js";
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url);
export async function generateArtifacts(
  referenceUrl: string,
  canonicalSql: string,
  root: string,
): Promise<void> {
  const schema = resolve(root, GENERATED_SCHEMA);
  const config = resolve(root, "prisma.config.ts");
  await mkdir(dirname(schema), { recursive: true });
  await writeFile(
    schema,
    `generator client {\n  provider = "prisma-client"\n  output = "../../src/generated/prisma"\n  moduleFormat = "esm"\n  runtime = "nodejs"\n  importFileExtension = "js"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n`,
  );
  await writeFile(
    config,
    `import { defineConfig } from ${JSON.stringify(pathToFileURL(require.resolve("prisma/config")).href)};\nexport default defineConfig({ schema: ${JSON.stringify(schema)}, datasource: { url: process.env.PRISMA_DATABASE_URL } });\n`,
  );
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: "production",
    PRISMA_HIDE_UPDATE_MESSAGE: "true",
    PRISMA_DATABASE_URL: referenceUrl,
  };
  await runPrisma(
    ["db", "pull", "--force", "--schema", schema, "--config", config],
    env,
  );
  await runPrisma(["validate", "--schema", schema, "--config", config], env);
  await runPrisma(["generate", "--schema", schema, "--config", config], env);
  const schemaText = await readFile(schema, "utf8");
  const pkg = async (name: string) =>
    JSON.parse(
      await readFile(
        resolve(process.cwd(), "node_modules", name, "package.json"),
        "utf8",
      ),
    ) as { version: string };
  const provenance: PrismaProvenance = {
    canonicalSha256: sha(canonicalSql),
    schemaSha256: sha(schemaText),
    prisma: (await pkg("prisma")).version,
    client: (await pkg("@prisma/client")).version,
    adapterPg: (await pkg("@prisma/adapter-pg")).version,
  };
  await writeFile(
    resolve(root, GENERATED_PROVENANCE),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}
export async function temporaryGenerationRoot(): Promise<string> {
  const root = resolve(tmpdir(), `billing-prisma-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}
