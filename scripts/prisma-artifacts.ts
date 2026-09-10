import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { GENERATED_CLIENT } from "./prisma-generation.constants.js";

const paths = ["database/generated", GENERATED_CLIENT] as const;
async function collect(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(resolve(root, path), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const key = relative(root, resolve(root, path, entry.name));
      if (entry.isDirectory()) await walk(key);
      else out.set(key, await readFile(resolve(root, key)));
    }
  }
  for (const path of paths) await walk(path);
  return out;
}
export async function comparePrismaArtifacts(
  expectedRoot: string,
  actualRoot: string,
): Promise<{ missing: string[]; extra: string[]; changed: string[] }> {
  const expected = await collect(expectedRoot);
  const actual = await collect(actualRoot);
  return {
    missing: [...expected.keys()].filter((k) => !actual.has(k)).sort(),
    extra: [...actual.keys()].filter((k) => !expected.has(k)).sort(),
    changed: [...expected.entries()]
      .filter(([key, value]) => {
        const actualValue = actual.get(key);
        return actualValue !== undefined && !value.equals(actualValue);
      })
      .map(([key]) => key)
      .sort(),
  };
}
export type ArtifactOperations = {
  rename?: (oldPath: string, newPath: string) => Promise<void>;
};
const PUBLISH_LOCK = ".billing-prisma-artifacts-publish.lock";

async function publishUnlocked(
  stagingRoot: string,
  destinationRoot: string,
  operations: ArtifactOperations,
): Promise<void> {
  const move = operations.rename ?? rename;
  const token = randomUUID();
  const entries = paths.map((path) => ({
    source: resolve(stagingRoot, path),
    target: resolve(destinationRoot, path),
    prepared: resolve(destinationRoot, `${path}.next-${token}`),
    backup: resolve(destinationRoot, `${path}.backup-${token}`),
    hadOriginal: false,
    targetVacated: false,
  }));
  const prepared = entries.map((entry) => entry.prepared);
  const backups = entries.map((entry) => entry.backup);
  let publishError: unknown;
  let publishFailed = false;
  const preparedCleanupErrors: unknown[] = [];
  try {
    for (const entry of entries) {
      await mkdir(dirname(entry.prepared), { recursive: true });
      await cp(entry.source, entry.prepared, { recursive: true });
    }
    for (const entry of entries) {
      try {
        await move(entry.target, entry.backup);
        entry.hadOriginal = true;
        entry.targetVacated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entry.targetVacated = true;
      }
      await move(entry.prepared, entry.target);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const entry of [...entries].reverse())
      try {
        if (!entry.targetVacated) continue;
        await rm(entry.target, { recursive: true, force: true });
        if (entry.hadOriginal) await move(entry.backup, entry.target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    publishError = rollbackErrors.length
      ? new AggregateError(
          [error, ...rollbackErrors],
          `Prisma artifact publish and rollback failed; backups: ${backups.join(", ")}`,
          { cause: error },
        )
      : error;
    publishFailed = true;
  } finally {
    for (const path of prepared)
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        preparedCleanupErrors.push(error);
      }
  }
  if (preparedCleanupErrors.length)
    throw new AggregateError(
      publishFailed
        ? [publishError, ...preparedCleanupErrors]
        : preparedCleanupErrors,
      `Prisma artifact staging cleanup failed: ${prepared.join(", ")}`,
      publishFailed ? { cause: publishError } : undefined,
    );
  if (publishFailed) throw publishError;
  const cleanupErrors: unknown[] = [];
  for (const backup of backups)
    try {
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      `Prisma artifacts published but backup cleanup failed: ${backups.join(", ")}`,
    );
}

export async function publishPrismaArtifacts(
  stagingRoot: string,
  destinationRoot = process.cwd(),
  operations: ArtifactOperations = {},
): Promise<void> {
  const lock = resolve(destinationRoot, PUBLISH_LOCK);
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Prisma artifact publication is already active; inspect ${PUBLISH_LOCK} if no publisher is running`,
        { cause: error },
      );
    throw error;
  }
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    await publishUnlocked(stagingRoot, destinationRoot, operations);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  try {
    await rm(lock, { recursive: true });
  } catch (cleanupError) {
    throw hasPrimaryError
      ? new AggregateError(
          [primaryError, cleanupError],
          `Prisma artifact publication and lock cleanup failed: ${PUBLISH_LOCK}`,
          { cause: primaryError },
        )
      : cleanupError;
  }
  if (hasPrimaryError) throw primaryError;
}
