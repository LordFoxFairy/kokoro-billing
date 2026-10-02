import { createClient } from "@hey-api/openapi-ts";
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
import {
  assertBillingApiArtifactBytes,
  billingApiArtifactNames,
  billingApiGenerator,
  createBillingApiProvenance,
  readBillingApiSource,
} from "./billing-api-artifacts.js";

async function readUtf8(path: string): Promise<string> {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text, "utf8"))) {
    throw new Error("Billing API invalid UTF-8 bytes: " + path);
  }
  return text;
}

async function readArtifacts(
  directory: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(directory)) {
    files[name] = await readUtf8(join(directory, name));
  }
  return files;
}

async function assertToolchain(root: string): Promise<void> {
  for (const [name, version] of [
    [billingApiGenerator.package, billingApiGenerator.version],
    [
      billingApiGenerator.formatter.package,
      billingApiGenerator.formatter.version,
    ],
    ["typescript", billingApiGenerator.typescript_version],
  ]) {
    const parsed: unknown = JSON.parse(
      await readFile(
        join(root, "node_modules", name ?? "", "package.json"),
        "utf8",
      ),
    );
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== version
    ) {
      throw new Error("Billing API installed toolchain version drift: " + name);
    }
  }
}

export async function generateBillingApiArtifacts(
  options: Readonly<{
    rootDirectory: string;
    outputDirectory?: string;
    mode: "write" | "check";
  }>,
): Promise<void> {
  const root = resolve(options.rootDirectory);
  const destination =
    options.outputDirectory ?? join(root, "src/generated/billing-api");
  await assertToolchain(root);
  const sourceText = await readUtf8(
    join(root, "contract/openapi/v2/openapi.yaml"),
  );
  readBillingApiSource(sourceText);
  const scratch = await mkdtemp(join(tmpdir(), "kokoro-billing-api-"));
  try {
    const snapshot = join(scratch, "openapi.yaml");
    const candidate = join(scratch, "output");
    await writeFile(snapshot, sourceText);
    await createClient({
      input: snapshot,
      logs: { level: "silent", file: false },
      output: {
        path: candidate,
        importFileExtension: billingApiGenerator.import_file_extension,
        postProcess: [
          {
            command: process.execPath,
            name: "Prettier (pinned local)",
            args: [
              join(root, "node_modules/prettier/bin/prettier.cjs"),
              "--config",
              join(root, billingApiGenerator.formatter.config),
              "--ignore-path",
              join(root, billingApiGenerator.formatter.ignore_path),
              "--no-editorconfig",
              "--write",
              "{{path}}/**/*.ts",
            ],
          },
        ],
      },
      plugins: billingApiGenerator.plugins,
    });
    const officialFiles = await readArtifacts(candidate);
    const provenance = createBillingApiProvenance({
      sourceText,
      officialFiles,
    });
    const files: Record<string, string> = {
      ...officialFiles,
      "provenance.json": await format(JSON.stringify(provenance), {
        parser: "json",
      }),
    };
    if (options.mode === "check") {
      assertBillingApiArtifactBytes(await readArtifacts(destination), files);
    } else {
      // A pre-existing foreign file is not removed or silently accepted.
      await mkdir(destination, { recursive: true });
      const existing = await readdir(destination);
      if (
        existing.some(
          (name) =>
            !billingApiArtifactNames.some((allowed) => allowed === name),
        )
      ) {
        throw new Error("Billing API unexpected destination file");
      }
      for (const name of billingApiArtifactNames) {
        await writeFile(join(destination, name), files[name] ?? "");
      }
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
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: generate-billing-api.ts [--check]");
  }
  await generateBillingApiArtifacts({
    rootDirectory: resolve(import.meta.dirname, ".."),
    mode: args[0] === "--check" ? "check" : "write",
  });
}
