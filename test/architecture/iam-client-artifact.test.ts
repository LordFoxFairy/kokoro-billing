import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const archive = "vendor/iam/kokoro-iam-client-0.7.0.tgz";
const archiveSha256 =
  "c988e5bd3b234aae0085fced5fcd629bcb3feb3d0fe5ebb5d1a384e44e77c014";
const archiveIntegrity =
  "sha512-oopYAYcVK0izx1zv4cdO68mGBq9biDRIh4j5kJMmEKxYFN54GP5IcyCqNZlH97pg/lphezhv0ZTT6fDvaFyF3g==";
const provenanceSchema = z
  .object({
    schema_version: z.literal(1),
    package: z
      .object({
        name: z.literal("@kokoro/iam-client"),
        version: z.literal("0.7.0"),
      })
      .strict(),
    source: z
      .object({
        commit: z.literal("0537b2d033d273f0ef7f5017502ba20e8571aba8"),
        dirty: z.literal(false),
      })
      .strict(),
    contract: z
      .object({
        path: z.literal("contract/openapi/iam.internal.v1.json"),
        sha256: z.literal(
          "c8d7af8a365ad5d13eaabccf7f31133e0918ef198bdc3e7c790d90933eae91b2",
        ),
      })
      .strict(),
    generator: z
      .object({
        package: z.literal("@hey-api/openapi-ts"),
        version: z.literal("0.99.0"),
        config_sha256: z.literal(
          "8e05c08692bb4fd810e172f3b637f4054b53d136044a00246e77477e8876a874",
        ),
      })
      .strict(),
    lockfile_sha256: z.literal(
      "3a1a895ed06932367a67ab11fc6811ceb7a16f9071fbab2aae2f01abbb27b506",
    ),
    runtime: z
      .object({
        node: z.literal("v24.20.0"),
        pnpm: z.literal("12.3.4"),
      })
      .strict(),
  })
  .strict();
const packageSchema = z
  .object({
    name: z.literal("@kokoro/iam-client"),
    version: z.literal("0.7.0"),
    type: z.literal("module"),
    license: z.literal("UNLICENSED"),
    engines: z.object({ node: z.literal(">=24 <25") }),
    exports: z.object({
      ".": z.object({
        types: z.literal("./dist/index.d.ts"),
        import: z.literal("./dist/index.js"),
      }),
    }),
    files: z.tuple([
      z.literal("dist"),
      z.literal("README.md"),
      z.literal("THIRD_PARTY_NOTICES.md"),
    ]),
    dependencies: z.object({ zod: z.literal("4.5.4") }),
  })
  .passthrough();

function archiveText(path: string): string {
  return execFileSync("tar", ["-xOf", archive, path], { encoding: "utf8" });
}

function json(value: string): unknown {
  return JSON.parse(value) as unknown;
}

const dependencyGroups = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const allowedSpecifier = `file:${archive}`;
const allowedLockIdentity = `@kokoro/iam-client@${allowedSpecifier}`;

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function assertSingleIamDependency(
  manifestValue: unknown,
  lockValue: unknown,
): void {
  const manifest = record(manifestValue);
  if (manifest.dependencies === undefined)
    throw new Error("missing primary IAM dependency group");
  const manifestDependencies = record(manifest.dependencies);
  if (manifestDependencies["@kokoro/iam-client"] !== allowedSpecifier)
    throw new Error("missing primary IAM dependency");
  for (const group of dependencyGroups) {
    const dependencies =
      manifest[group] === undefined ? {} : record(manifest[group]);
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (name === "@kokoro/iam-client" && group === "dependencies") {
        expect(specifier).toBe(allowedSpecifier);
        continue;
      }
      if (
        name.includes("iam-client") ||
        (typeof specifier === "string" &&
          (specifier.includes("kokoro-iam") ||
            specifier.includes("iam-client") ||
            /^(?:workspace:|link:|file:(?:\/|\.\.\/|[A-Za-z]:))/u.test(
              specifier,
            )))
      )
        throw new Error(`unapproved IAM dependency ${group}.${name}`);
    }
  }

  const lock = record(lockValue);
  const importers = record(lock.importers);
  const rootImporter = record(importers["."]);
  if (rootImporter.dependencies === undefined)
    throw new Error("missing primary IAM lock dependency group");
  const lockDependencies = record(rootImporter.dependencies);
  assert.deepStrictEqual(
    record(lockDependencies["@kokoro/iam-client"]),
    { specifier: allowedSpecifier, version: allowedSpecifier },
    "missing or incomplete primary IAM lock binding",
  );
  for (const group of dependencyGroups) {
    const dependencies =
      rootImporter[group] === undefined ? {} : record(rootImporter[group]);
    for (const [name, binding] of Object.entries(dependencies)) {
      if (name === "@kokoro/iam-client" && group === "dependencies") {
        expect(record(binding).specifier).toBe(allowedSpecifier);
        expect(record(binding).version).toBe(allowedSpecifier);
        continue;
      }
      const serialized = JSON.stringify(binding);
      if (
        name.includes("iam-client") ||
        serialized.includes("kokoro-iam") ||
        serialized.includes("iam-client") ||
        serialized.includes("workspace:") ||
        serialized.includes("link:")
      )
        throw new Error(`unapproved IAM lock importer ${group}.${name}`);
    }
  }
  for (const section of ["packages", "snapshots"] as const) {
    const iamKeys = Object.keys(record(lock[section])).filter((key) =>
      key.includes("@kokoro/iam-client"),
    );
    expect(iamKeys).toEqual([allowedLockIdentity]);
  }
}

describe("IAM SDK immutable artifact", () => {
  it("pins the only vendor archive by bytes and both digests", () => {
    const bytes = readFileSync(archive);
    expect(statSync(archive).size).toBe(64_012);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      archiveSha256,
    );
    expect(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    ).toBe(archiveIntegrity);
    expect(readdirSync("vendor/iam").sort()).toEqual([
      "kokoro-iam-client-0.7.0.tgz",
      "provenance.json",
    ]);
  });

  it("keeps the exact owner provenance inside and beside the archive", () => {
    const sidecar = provenanceSchema.parse(
      json(readFileSync("vendor/iam/provenance.json", "utf8")),
    );
    const inner = provenanceSchema.parse(
      json(archiveText("package/dist/provenance.json")),
    );
    assert.deepStrictEqual(inner, sidecar);
    for (const key of [
      "package",
      "source",
      "contract",
      "generator",
      "runtime",
    ] as const) {
      const mutant = record(structuredClone(sidecar));
      mutant[key] = { ...record(mutant[key]), unknown: true };
      expect(() => provenanceSchema.parse(mutant)).toThrow();
    }
  });

  it("exposes only the owner package root with private license notices", () => {
    packageSchema.parse(json(archiveText("package/package.json")));
    const entries = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .sort();
    expect(entries).toHaveLength(96);
    expect(entries).toContain("package/dist/index.js");
    expect(entries).toContain("package/dist/index.d.ts");
    expect(entries).toContain("package/README.md");
    expect(entries).toContain("package/THIRD_PARTY_NOTICES.md");
    expect(
      entries.every(
        (entry) =>
          entry.startsWith("package/dist/") ||
          entry === "package/package.json" ||
          entry === "package/README.md" ||
          entry === "package/THIRD_PARTY_NOTICES.md",
      ),
    ).toBe(true);
    const notices = archiveText("package/THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("@hey-api/openapi-ts` 0.99.0");
    expect(notices).toContain("`zod` 4.5.4");
  });

  it("binds the manifest and every IAM lock section to the same archive", () => {
    const manifest = json(readFileSync("package.json", "utf8"));
    const lock = readFileSync("pnpm-lock.yaml", "utf8");
    const parsedLock: unknown = parse(lock);
    assertSingleIamDependency(manifest, parsedLock);
    expect(lock.match(/kokoro-iam-client-0\.7\.0\.tgz/gu)).toHaveLength(5);
    expect(lock.match(/kokoro-iam-client-0\.6\.0\.tgz/gu) ?? []).toHaveLength(
      0,
    );
    expect(lock).toContain(`integrity: ${archiveIntegrity}`);
    expect(lock).toContain("    version: 0.7.0");
    expect(lock).toContain("    engines: {node: '>=24 <25'}");
    expect(lock).toContain("      zod: 4.5.4");

    for (const [group, locator] of [
      ["dependencies", "workspace:../kokoro-iam/sdk"],
      ["devDependencies", "link:../kokoro-iam/sdk"],
      ["optionalDependencies", "file:../kokoro-iam/sdk"],
      ["peerDependencies", "file:/tmp/kokoro-iam-client-0.7.0.tgz"],
    ] as const) {
      const mutant = structuredClone(record(manifest));
      const dependencies =
        mutant[group] === undefined ? {} : record(mutant[group]);
      dependencies["@kokoro/iam-client-shadow"] = locator;
      mutant[group] = dependencies;
      expect(() => assertSingleIamDependency(mutant, parsedLock)).toThrow(
        "unapproved IAM dependency",
      );
    }

    for (const mutate of [
      (value: Record<string, unknown>) => {
        const dependencies = record(value.dependencies);
        delete dependencies["@kokoro/iam-client"];
        value.dependencies = dependencies;
      },
      (value: Record<string, unknown>) => {
        delete value.dependencies;
      },
    ]) {
      const mutant = structuredClone(record(manifest));
      mutate(mutant);
      expect(() => assertSingleIamDependency(mutant, parsedLock)).toThrow(
        "missing primary IAM dependency",
      );
    }

    for (const mutate of [
      (value: Record<string, unknown>) => {
        const importers = record(value.importers);
        const root = record(importers["."]);
        const dependencies = record(root.dependencies);
        delete dependencies["@kokoro/iam-client"];
        root.dependencies = dependencies;
        importers["."] = root;
        value.importers = importers;
      },
      (value: Record<string, unknown>) => {
        const importers = record(value.importers);
        const root = record(importers["."]);
        delete root.dependencies;
        importers["."] = root;
        value.importers = importers;
      },
    ]) {
      const mutant = structuredClone(record(parsedLock));
      mutate(mutant);
      expect(() => assertSingleIamDependency(manifest, mutant)).toThrow();
    }

    for (const section of ["packages", "snapshots"] as const) {
      const mutant = structuredClone(record(parsedLock));
      mutant[section] = {
        ...record(mutant[section]),
        "@kokoro/iam-client-shadow@workspace:../sdk": {},
      };
      expect(() => assertSingleIamDependency(manifest, mutant)).toThrow();
    }
  });
});
