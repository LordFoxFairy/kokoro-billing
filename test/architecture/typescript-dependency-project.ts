import { readdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { analyzeDependencies } from "./typescript-dependency-graph.js";
import type { DependencyGraph } from "./typescript-dependency.types.js";

export async function readBillingDependencyGraph(
  root = process.cwd(),
): Promise<DependencyGraph> {
  root = await realpath(root);
  const configPath = resolve(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    undefined,
    configPath,
  );
  if (parsed.errors.length)
    throw new Error(
      parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    );
  const files = new Map<string, string>();
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (path === resolve(root, "src/generated/prisma")) continue;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:ts|mts|cts|tsx)$/.test(entry.name))
        files.set(path, await readFile(path, "utf8"));
      else if (entry.isSymbolicLink())
        throw new Error(`Unsupported source symlink: ${path}`);
    }
  }
  await walk(resolve(root, "src"));
  return analyzeDependencies({
    root,
    files,
    options: parsed.options,
    host: ts.sys,
  });
}
