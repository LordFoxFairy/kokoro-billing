import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { describe, expect, it } from "vitest";

// Local schemas validate only the configuration consumed by this governance test.
const packageSchema = z.object({
  packageManager: z.string(),
  engines: z.object({ node: z.string() }),
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});
const lockedDependencies = z.record(
  z.string(),
  z.object({ specifier: z.string(), version: z.string() }),
);
const lockSchema = z.object({
  importers: z.object({
    ".": z.object({
      dependencies: lockedDependencies,
      devDependencies: lockedDependencies,
    }),
  }),
});
const workspaceSchema = z.object({ engineStrict: z.literal(true) });
const stepSchema = z.object({
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  if: z.never().optional(),
  "continue-on-error": z.never().optional(),
});
const workflowSchema = z.object({
  jobs: z.object({
    verify: z.object({
      env: z.object({ SCHEMA_ADMIN_URL: z.string().url() }),
      steps: z.array(stepSchema),
      if: z.never().optional(),
      "continue-on-error": z.never().optional(),
    }),
  }),
});
const nodeSetupSchema = z.object({
  "node-version-file": z.literal(".node-version"),
  cache: z.literal("pnpm"),
}).strict();
const pnpmSetupSchema = z.object({ version: z.literal("11.25.0") }).strict();
const devPins = {
  "@types/node": "24.13.3",
  typescript: "5.9.3",
  vitest: "5.0.0",
  vite: "8.2.2",
};
const required = [
  "pnpm install --frozen-lockfile",
  "pnpm db:apply-schema",
  "pnpm test:integration",
  "pnpm db:verify-schema",
  "pnpm prisma:generate && pnpm prisma:check",
  "pnpm verify",
] as const;
const approvedImage =
  "node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";

function fail(code: string): never {
  throw new Error(code);
}

function checkManifest(manifestInput: unknown, lockInput: unknown): void {
  const manifestResult = packageSchema.safeParse(manifestInput);
  if (!manifestResult.success) fail("manifest-shape");
  const lockResult = lockSchema.safeParse(lockInput);
  if (!lockResult.success) fail("lock-shape");
  const manifest = manifestResult.data;
  const importer = lockResult.data.importers["."];
  if (manifest.packageManager !== "pnpm@11.25.0") fail("manifest-pnpm");
  if (manifest.engines.node !== "24.20.0") fail("manifest-node");
  for (const [name, version] of Object.entries(devPins)) {
    if (manifest.devDependencies[name] !== version) fail(`manifest-pin:${name}`);
  }
  for (const groupName of ["dependencies", "devDependencies"] as const) {
    const group = manifest[groupName];
    for (const [name, version] of Object.entries(group)) {
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
        fail(`manifest-exact:${name}`);
      }
      const locked = importer[groupName][name];
      if (!locked) fail(`lock-missing:${name}`);
      if (locked.specifier !== version) fail(`lock-specifier:${name}`);
      if (locked.version.split("(")[0] !== version) fail(`lock-version:${name}`);
    }
    for (const name of Object.keys(importer[groupName])) {
      if (!(name in group)) fail(`lock-extra:${name}`);
    }
  }
}

function checkRuntime(nodeVersion: string, workspaceInput: unknown): void {
  if (nodeVersion !== "24.20.0\n") fail("node-file");
  if (!workspaceSchema.safeParse(workspaceInput).success) fail("workspace-engines");
}

function checkWorkflow(input: unknown): void {
  const result = workflowSchema.safeParse(input);
  if (!result.success) {
    // Include the failing input path so malformed fixtures prove the intended cause.
    fail(`workflow-shape:${result.error.issues.map((issue) => issue.path.join(".")).join(",")}`);
  }
  const steps = result.data.jobs.verify.steps;
  const nodes = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
  const pnpms = steps.filter((step) => step.uses?.startsWith("pnpm/action-setup@"));
  const node = nodes[0];
  const pnpm = pnpms[0];
  if (nodes.length !== 1 || !node || !nodeSetupSchema.safeParse(node.with).success) {
    fail("node-setup");
  }
  if (pnpms.length !== 1 || !pnpm || !pnpmSetupSchema.safeParse(pnpm.with).success) {
    fail("pnpm-setup");
  }
  const commands = steps.flatMap((step) => step.run === undefined ? [] : [step.run]);
  if (commands.some((command) => /\becho\s+["']?pnpm\b/iu.test(command))) fail("echo");
  if (commands.some((command) => /\|\|\s*true\b/iu.test(command))) fail("ignore-failure");
  if (commands.some((command) => /--no-optional\b/iu.test(command))) fail("no-optional");
  // Only the current explicit gate commands are supported, not shell substring matches.
  let prior = Math.max(steps.indexOf(node), steps.indexOf(pnpm));
  for (const command of required) {
    const index = steps.findIndex((step) => step.run === command);
    if (index < 0) fail(`missing:${command}`);
    if (index <= prior) fail("order");
    prior = index;
  }
}

function checkDockerfile(text: string): void {
  const stages = new Set<string>();
  let fromCount = 0;
  let externalCount = 0;
  for (const raw of text.split("\n")) {
    if (!/^\s*FROM\b/iu.test(raw)) continue;
    const match = /^\s*FROM\s+([\w:./@-]+)(?:\s+AS\s+([\w-]+))?\s*$/iu.exec(raw);
    const source = match?.[1];
    if (!source) fail("docker-syntax");
    fromCount += 1;
    if (source === approvedImage) externalCount += 1;
    else if (!stages.has(source.toLowerCase())) fail("docker-image");
    const stage = match?.[2]?.toLowerCase();
    if (stage) {
      if (stages.has(stage)) fail("docker-stage-duplicate");
      stages.add(stage);
    }
  }
  if (fromCount === 0) fail("docker-empty");
  // B7a preserves the two approved external bases: package-manager and runtime.
  if (externalCount !== 2) fail("docker-external-count");
}

// Small valid fixtures; every negative test checks its baseline before changing one fact.
const manifestFixture = {
  packageManager: "pnpm@11.25.0",
  engines: { node: "24.20.0" },
  dependencies: { zod: "3.25.76" },
  devDependencies: { ...devPins, yaml: "2.9.0" },
};
function lockGroup(group: Record<string, string>): z.infer<typeof lockedDependencies> {
  return Object.fromEntries(Object.entries(group).map(([name, version]) => [
    name, { specifier: version, version },
  ]));
}
const importerFixture = {
  dependencies: lockGroup(manifestFixture.dependencies),
  devDependencies: lockGroup(manifestFixture.devDependencies),
};
const lockFixture = { importers: { ".": importerFixture } };
const pnpmStep = { uses: "pnpm/action-setup@fixture", with: { version: "11.25.0" } };
const nodeStep = {
  uses: "actions/setup-node@fixture",
  with: { "node-version-file": ".node-version", cache: "pnpm" },
};
const gateSteps = required.map((run) => ({ run }));
const workflowFixture = {
  jobs: { verify: {
    env: { SCHEMA_ADMIN_URL: "postgresql://localhost/fixture" },
    steps: [pnpmStep, nodeStep, ...gateSteps],
  } },
};
function withSteps(steps: unknown): unknown {
  return { jobs: { verify: { ...workflowFixture.jobs.verify, steps } } };
}
const dockerFixture = `FROM ${approvedImage} AS package-manager
FROM package-manager AS build
FROM package-manager AS production-dependencies
FROM ${approvedImage} AS runtime`;

describe("toolchain governance", () => {
  it("pins the real manifest, lockfile, and local runtime policy", async () => {
    const manifest: unknown = JSON.parse(await readFile("package.json", "utf8"));
    const lock: unknown = parse(await readFile("pnpm-lock.yaml", "utf8"));
    const workspace: unknown = parse(await readFile("pnpm-workspace.yaml", "utf8"));
    checkManifest(manifest, lock);
    checkRuntime(await readFile(".node-version", "utf8"), workspace);
  });

  it.each([
    ["package manager", { ...manifestFixture, packageManager: "pnpm@11" }, "manifest-pnpm"],
    ["Node runtime", { ...manifestFixture, engines: { node: "22.22.2" } }, "manifest-node"],
    ...Object.entries(devPins).map(([name]) => [
      name,
      { ...manifestFixture, devDependencies: { ...manifestFixture.devDependencies, [name]: "7.0.2" } },
      `manifest-pin:${name}`,
    ] as const),
    ...["^3.25.76", "~3.25.76", "latest", "3.25", "03.25.76", "3.25.76-beta.1"].map((version) => [
      `floating or non-stable direct dependency ${version}`,
      { ...manifestFixture, dependencies: { zod: version } },
      "manifest-exact:zod",
    ] as const),
    ["floating dev dependency", { ...manifestFixture, devDependencies: { ...manifestFixture.devDependencies, yaml: "^2.9.0" } }, "manifest-exact:yaml"],
    ["missing manifest shape", {}, "manifest-shape"],
  ] as const)("rejects manifest regression: %s", (_name, manifest, code) => {
    expect(() => checkManifest(manifestFixture, lockFixture)).not.toThrow();
    expect(() => checkManifest(manifest, lockFixture)).toThrow(new Error(code));
  });

  it.each([
    ["dependencies", "zod", "3.25.76"],
    ["devDependencies", "yaml", "2.9.0"],
  ] as const)("checks specifier and resolved version in %s", (group, name, version) => {
    expect(() => checkManifest(manifestFixture, lockFixture)).not.toThrow();
    for (const [entry, code] of [
      [{ specifier: `^${version}`, version }, `lock-specifier:${name}`],
      [{ specifier: version, version: "0.0.1(peer@1.0.0)" }, `lock-version:${name}`],
    ] as const) {
      const importer = { ...importerFixture, [group]: { ...importerFixture[group], [name]: entry } };
      expect(() => checkManifest(manifestFixture, { importers: { ".": importer } })).toThrow(new Error(code));
    }
    const peerImporter = { ...importerFixture, [group]: {
      ...importerFixture[group], [name]: { specifier: version, version: `${version}(peer@1.0.0)` },
    } };
    expect(() => checkManifest(manifestFixture, { importers: { ".": peerImporter } })).not.toThrow();
    const missing = Object.fromEntries(Object.entries(importerFixture[group]).filter(([key]) => key !== name));
    expect(() => checkManifest(manifestFixture, { importers: { ".": { ...importerFixture, [group]: missing } } })).toThrow(new Error(`lock-missing:${name}`));
    const extra = { ...importerFixture[group], extra: { specifier: "1.0.0", version: "1.0.0" } };
    expect(() => checkManifest(manifestFixture, { importers: { ".": { ...importerFixture, [group]: extra } } })).toThrow(new Error("lock-extra:extra"));
  });

  it("rejects malformed lock input", () => {
    expect(() => checkManifest(manifestFixture, lockFixture)).not.toThrow();
    expect(() => checkManifest(manifestFixture, { importers: { ".": null } })).toThrow(new Error("lock-shape"));
  });

  it.each([
    ["22.22.2\n", { engineStrict: true }, "node-file"],
    ["24.20.0\n", { engineStrict: false }, "workspace-engines"],
    ["24.20.0\n", {}, "workspace-engines"],
    ["24.20.0\n", { engineStrict: "true" }, "workspace-engines"],
  ] as const)("rejects weakened local runtime policy (%s, %j)", (node, workspace, code) => {
    expect(() => checkRuntime("24.20.0\n", { engineStrict: true })).not.toThrow();
    expect(() => checkRuntime(node, workspace)).toThrow(new Error(code));
  });

  it.each([".github/workflows/ci.yml", ".github/workflows/release-image.yml"])(
    "validates ordered verify job in %s",
    async (path) => checkWorkflow(parse(await readFile(path, "utf8"))),
  );

  it.each([
    ["missing jobs", {}, "jobs"],
    ["wrong jobs type", { jobs: [] }, "jobs"],
    ["missing verify", { jobs: {} }, "jobs.verify"],
    ["missing steps", { jobs: { verify: { env: workflowFixture.jobs.verify.env } } }, "jobs.verify.steps"],
    ["wrong steps type", withSteps({}), "jobs.verify.steps"],
    ["missing env", { jobs: { verify: { steps: workflowFixture.jobs.verify.steps } } }, "jobs.verify.env"],
    ["wrong env type", { jobs: { verify: { ...workflowFixture.jobs.verify, env: [] } } }, "jobs.verify.env"],
    ["missing schema admin URL", { jobs: { verify: { ...workflowFixture.jobs.verify, env: {} } } }, "jobs.verify.env.SCHEMA_ADMIN_URL"],
    ["wrong schema admin URL type", { jobs: { verify: { ...workflowFixture.jobs.verify, env: { SCHEMA_ADMIN_URL: 1 } } } }, "jobs.verify.env.SCHEMA_ADMIN_URL"],
    ["wrong run type", withSteps([pnpmStep, nodeStep, { run: 1 }, ...gateSteps.slice(1)]), "jobs.verify.steps.2.run"],
    ["wrong uses type", withSteps([{ ...pnpmStep, uses: false }, nodeStep, ...gateSteps]), "jobs.verify.steps.0.uses"],
    ...["if", "continue-on-error"].flatMap((key) => [
      [`job ${key}`, { jobs: { verify: { ...workflowFixture.jobs.verify, [key]: true } } }, `jobs.verify.${key}`],
      [`step ${key}`, withSteps([pnpmStep, nodeStep, { run: required[0], [key]: true }, ...gateSteps.slice(1)]), `jobs.verify.steps.2.${key}`],
    ] as const),
  ] as const)("rejects workflow shape regression: %s", (_name, workflow, path) => {
    expect(() => checkWorkflow(workflowFixture)).not.toThrow();
    expect(() => checkWorkflow(workflow)).toThrow(new Error(`workflow-shape:${path}`));
  });

  it.each([
    ["missing node setup", [pnpmStep, ...gateSteps], "node-setup"],
    ["duplicate node setup", [pnpmStep, nodeStep, nodeStep, ...gateSteps], "node-setup"],
    ["node version overrides file", [pnpmStep, { ...nodeStep, with: { ...nodeStep.with, "node-version": "22" } }, ...gateSteps], "node-setup"],
    ["wrong node version file", [pnpmStep, { ...nodeStep, with: { ...nodeStep.with, "node-version-file": ".nvmrc" } }, ...gateSteps], "node-setup"],
    ["missing pnpm setup", [nodeStep, ...gateSteps], "pnpm-setup"],
    ["duplicate pnpm setup", [pnpmStep, pnpmStep, nodeStep, ...gateSteps], "pnpm-setup"],
    ["wrong pnpm version", [{ ...pnpmStep, with: { version: "11" } }, nodeStep, ...gateSteps], "pnpm-setup"],
    ["late node setup", [pnpmStep, { run: required[0] }, nodeStep, ...gateSteps.slice(1)], "order"],
    ["late pnpm setup", [nodeStep, { run: required[0] }, pnpmStep, ...gateSteps.slice(1)], "order"],
    ...required.flatMap((command) => [
      [`missing ${command}`, [pnpmStep, nodeStep, ...gateSteps.filter((step) => step.run !== command)], `missing:${command}`],
      [`echo ${command}`, [pnpmStep, nodeStep, ...gateSteps.map((step) => step.run === command ? { run: `echo "${command}"` } : step)], "echo"],
      [`ignored failure ${command}`, [pnpmStep, nodeStep, ...gateSteps.map((step) => step.run === command ? { run: `${command} || true` } : step)], "ignore-failure"],
    ] as const),
    ["no optional bindings", [pnpmStep, nodeStep, { run: `${required[0]} --no-optional` }, ...gateSteps.slice(1)], "no-optional"],
    ["integration before schema", [pnpmStep, nodeStep, { run: required[0] }, { run: required[2] }, { run: required[1] }, ...gateSteps.slice(3)], "order"],
  ] as const)("rejects workflow gate regression: %s", (_name, steps, code) => {
    expect(() => checkWorkflow(workflowFixture)).not.toThrow();
    expect(() => checkWorkflow(withSteps(steps))).toThrow(new Error(code));
  });

  it("accepts reordered YAML mapping keys and unrelated steps between gates", () => {
    expect(() => checkWorkflow(workflowFixture)).not.toThrow();
    const reorderedNode = { with: { cache: "pnpm", "node-version-file": ".node-version" }, uses: nodeStep.uses };
    expect(() => checkWorkflow(withSteps([
      pnpmStep, reorderedNode, { run: required[0] },
      { uses: "aquasecurity/trivy-action@fixture" }, ...gateSteps.slice(1),
    ]))).not.toThrow();
  });

  it("checks the real Dockerfile", async () => {
    checkDockerfile(await readFile("Dockerfile", "utf8"));
  });

  it("accepts case and leading whitespace and only previously defined stages", () => {
    expect(() => checkDockerfile(dockerFixture)).not.toThrow();
    expect(() => checkDockerfile(dockerFixture.replaceAll("FROM", "  fRoM").replaceAll(" AS ", " aS "))).not.toThrow();
    expect(() => checkDockerfile(dockerFixture.replace("FROM package-manager AS build", "FROM PACKAGE-MANAGER AS build"))).not.toThrow();
  });

  it.each([
    ["empty Dockerfile", "", "docker-empty"],
    ["comment-only Dockerfile", "# FROM node:latest\n", "docker-empty"],
    ["unapproved image", dockerFixture.replace(approvedImage, "node:latest"), "docker-image"],
    ["extra external FROM", `${dockerFixture}\n  from node:latest as extra`, "docker-image"],
    ["extra approved external FROM", `${dockerFixture}\nFROM ${approvedImage} AS extra`, "docker-external-count"],
    ["missing external runtime", dockerFixture.replace(`FROM ${approvedImage} AS runtime`, "FROM package-manager AS runtime"), "docker-external-count"],
    ["forward stage reference", dockerFixture.replace("FROM package-manager AS build", "FROM runtime AS build"), "docker-image"],
    ["unknown stage", `${dockerFixture}\nFROM unknown-stage AS extra`, "docker-image"],
    ["duplicate stage", `${dockerFixture}\nFROM build AS build`, "docker-stage-duplicate"],
    ...["FROM", "  from --platform=linux/amd64 node:latest AS extra", "FROM node:latest AS bad extra", "FROM node:latest \\", "FROM node:latest # comment"].map((line) => [
      `unparsed ${line}`, `${dockerFixture}\n${line}`, "docker-syntax",
    ] as const),
  ] as const)("rejects Docker regression: %s", (_name, docker, code) => {
    expect(() => checkDockerfile(dockerFixture)).not.toThrow();
    expect(() => checkDockerfile(docker)).toThrow(new Error(code));
  });
});
