import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PRISMA_VERSION } from "../../scripts/prisma-generation.constants.js";
import {
  comparePrismaArtifacts,
  publishPrismaArtifacts,
} from "../../scripts/prisma-artifacts.js";
import { runPrisma } from "../../scripts/prisma-process.js";

const execFileAsync = promisify(execFile);

describe("Prisma generation metadata", () => {
  it("pins the supported toolchain and records actual package versions", async () => {
    const provenance = JSON.parse(
      await readFile("database/generated/provenance.json", "utf8"),
    ) as Record<string, string>;
    expect(PRISMA_VERSION).toBe("7.10.0");
    expect(provenance).toMatchObject({
      prisma: "7.10.0",
      client: "7.10.0",
      adapterPg: "7.10.0",
    });
    expect(JSON.stringify(provenance)).not.toMatch(
      /postgresql:|billing_reference_|\/Users\//u,
    );
  });

  it("records the introspected partial-index exception and stable ESM imports", async () => {
    const schema = await readFile("database/generated/schema.prisma", "utf8");
    expect(schema).toContain('previewFeatures     = ["partialIndexes"]');
    expect(schema).toContain('importFileExtension = "js"');
    expect(await readFile("src/generated/prisma/client.ts", "utf8")).toContain(
      'from "./internal/class.js"',
    );
  });

  it("reports missing, extra, and changed bytes without modifying artifacts", async () => {
    const expected = await mkdtemp(resolve(tmpdir(), "prisma-expected-"));
    const actual = await mkdtemp(resolve(tmpdir(), "prisma-actual-"));
    try {
      for (const root of [expected, actual])
        await mkdir(resolve(root, "database/generated"), { recursive: true });
      await writeFile(
        resolve(expected, "database/generated/schema.prisma"),
        "expected",
      );
      await writeFile(
        resolve(expected, "database/generated/provenance.json"),
        "missing",
      );
      await writeFile(
        resolve(actual, "database/generated/schema.prisma"),
        "changed",
      );
      await writeFile(resolve(actual, "database/generated/extra"), "extra");
      const before = await readFile(
        resolve(actual, "database/generated/schema.prisma"),
      );
      expect(await comparePrismaArtifacts(expected, actual)).toEqual({
        missing: ["database/generated/provenance.json"],
        extra: ["database/generated/extra"],
        changed: ["database/generated/schema.prisma"],
      });
      expect(
        await readFile(resolve(actual, "database/generated/schema.prisma")),
      ).toEqual(before);
    } finally {
      await rm(expected, { recursive: true, force: true });
      await rm(actual, { recursive: true, force: true });
    }
  });

  it("rolls back old artifacts after a deterministic rename failure", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "prisma-stage-"));
    const destination = await mkdtemp(resolve(tmpdir(), "prisma-destination-"));
    try {
      for (const root of [staging, destination])
        for (const path of ["database/generated", "src/generated/prisma"])
          await mkdir(resolve(root, path), { recursive: true });
      await writeFile(
        resolve(staging, "database/generated/schema.prisma"),
        "new-schema",
      );
      await writeFile(
        resolve(staging, "src/generated/prisma/client.ts"),
        "new-client",
      );
      await writeFile(
        resolve(destination, "database/generated/schema.prisma"),
        "old-schema",
      );
      await writeFile(
        resolve(destination, "src/generated/prisma/client.ts"),
        "old-client",
      );
      let calls = 0;
      await expect(
        publishPrismaArtifacts(staging, destination, {
          rename: async (from, to) => {
            calls += 1;
            if (calls === 4) throw new Error("injected publish failure");
            await rename(from, to);
          },
        }),
      ).rejects.toThrow("injected publish failure");
      expect(
        await readFile(
          resolve(destination, "database/generated/schema.prisma"),
          "utf8",
        ),
      ).toBe("old-schema");
      expect(
        await readFile(
          resolve(destination, "src/generated/prisma/client.ts"),
          "utf8",
        ),
      ).toBe("old-client");
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent publisher without disturbing the lock holder", async () => {
    const first = await mkdtemp(resolve(tmpdir(), "prisma-first-"));
    const second = await mkdtemp(resolve(tmpdir(), "prisma-second-"));
    const destination = await mkdtemp(resolve(tmpdir(), "prisma-destination-"));
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolvePause) => {
      releaseFirst = resolvePause;
    });
    let firstRenameStarted!: () => void;
    const renameStarted = new Promise<void>((resolveStarted) => {
      firstRenameStarted = resolveStarted;
    });
    try {
      for (const [root, value] of [
        [first, "first"],
        [second, "second"],
        [destination, "old"],
      ] as const) {
        await mkdir(resolve(root, "database/generated"), { recursive: true });
        await mkdir(resolve(root, "src/generated/prisma"), { recursive: true });
        await writeFile(
          resolve(root, "database/generated/schema.prisma"),
          value,
        );
        await writeFile(resolve(root, "src/generated/prisma/client.ts"), value);
      }
      let paused = false;
      const firstPublish = publishPrismaArtifacts(first, destination, {
        rename: async (oldPath, newPath) => {
          if (!paused) {
            paused = true;
            firstRenameStarted();
            await firstPaused;
          }
          await rename(oldPath, newPath);
        },
      });
      await renameStarted;
      await expect(publishPrismaArtifacts(second, destination)).rejects.toThrow(
        /already active/iu,
      );
      releaseFirst();
      await firstPublish;
      expect(
        await readFile(
          resolve(destination, "database/generated/schema.prisma"),
          "utf8",
        ),
      ).toBe("first");
      expect(
        await readFile(
          resolve(destination, "src/generated/prisma/client.ts"),
          "utf8",
        ),
      ).toBe("first");
    } finally {
      releaseFirst?.();
      await Promise.all(
        [first, second, destination].map((root) =>
          rm(root, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("terminates its dedicated process group and waits for parent and child close", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "prisma-process-"));
    const script = resolve(root, "fixture.mjs");
    const marker = resolve(root, "pids.json");
    await writeFile(
      script,
      `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(process.env.MARKER,JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`,
    );
    try {
      await expect(
        runPrisma([], { ...process.env, MARKER: marker }, 100, script),
      ).rejects.toThrow(/time budget/iu);
      const pids = JSON.parse(await readFile(marker, "utf8")) as {
        parent: number;
        child: number;
      };
      for (const pid of [pids.parent, pids.child])
        expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts malformed admin URLs from both Prisma CLIs", async () => {
    const secret = "SECRET_FIXTURE";
    for (const script of [
      "scripts/prisma-check.ts",
      "scripts/prisma-refresh.ts",
    ]) {
      let output = "";
      try {
        await execFileAsync("pnpm", ["exec", "tsx", script], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SCHEMA_ADMIN_URL: `postgresql://fixture_user:${secret}@[bad`,
          },
        });
      } catch (error) {
        const result = error as { stdout?: string; stderr?: string };
        output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      }
      expect(output).toContain("schema verification failed");
      expect(output).not.toContain(secret);
      expect(output).not.toContain("ERR_INVALID_URL");
    }
  });
});
