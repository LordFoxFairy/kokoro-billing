import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readAgentUsageArtifacts } from "../../scripts/generate-agent-usage.js";

it("pins the exact historical sealed reader while preserving the entire HTTP7.1 wire", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const release = await readAgentUsageArtifacts(root);
  expect(release.http.version).toBe("7.2.0");
  expect(release.http.sha256).toBe(
    "4e75244c676e02736867d2f461d18b4d67d93151ff03ffaf6e632685b77ca9db",
  );
  const raw = await readFile(
    resolve(root, "vendor/agent/http/v7/openapi.json"),
    "utf8",
  );
  const document = JSON.parse(raw) as {
    info: { version: string };
    paths: Record<string, { get: { description?: string } }>;
  };
  const operation =
    document.paths[
      "/v1/model-call-attempts/{attempt_id}/usage-evidence/{event_id}"
    ]?.get;
  expect(operation?.description).toContain("historical");
  expect(operation?.description).toContain("current head");
  expect(operation?.description).toContain("execution permission");
  if (!operation) throw new Error("sealed evidence operation is absent");
  // Do not re-serialize the complete owner JSON: JS rounds int64 bounds and
  // reorders integer-like response keys. Invert only the two accepted raw edits.
  const description = `,\n        "description": ${JSON.stringify(operation.description)}`;
  expect(raw.split(description)).toHaveLength(2);
  const version = '    "version": "7.2.0"\n';
  expect(raw.split(version)).toHaveLength(2);
  const parent = raw
    .replace(description, "")
    .replace(version, '    "version": "7.1.0"\n');
  expect(createHash("sha256").update(parent).digest("hex")).toBe(
    "6c0f532d983367ce3a22e05ffab00f83b7a4481de04f7121e72dd2a5098365a5",
  );
});
