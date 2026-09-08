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
    changed: [...expected.keys()]
      .filter((k) => actual.has(k) && !expected.get(k)!.equals(actual.get(k)!))
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
  const prepared = paths.map((path) =>
    resolve(destinationRoot, `${path}.next-${token}`),
  );
  const backups = paths.map((path) =>
    resolve(destinationRoot, `${path}.backup-${token}`),
  );
  const hadOriginal = [false, false];
  const targetVacated = [false, false];
  let swapped = 0;
  let publishError: unknown;
  let publishFailed = false;
  const preparedCleanupErrors: unknown[] = [];
  try {
    for (let i = 0; i < paths.length; i += 1) {
      await mkdir(dirname(prepared[i]!), { recursive: true });
      await cp(resolve(stagingRoot, paths[i]!), prepared[i]!, {
        recursive: true,
      });
    }
    for (let i = 0; i < paths.length; i += 1) {
      try {
        await move(resolve(destinationRoot, paths[i]!), backups[i]!);
        hadOriginal[i] = true;
        targetVacated[i] = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        targetVacated[i] = true;
      }
      await move(prepared[i]!, resolve(destinationRoot, paths[i]!));
      swapped += 1;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (let i = Math.min(swapped, paths.length - 1); i >= 0; i -= 1)
      try {
        if (!targetVacated[i]) continue;
        await rm(resolve(destinationRoot, paths[i]!), {
          recursive: true,
          force: true,
        });
        if (hadOriginal[i])
          await move(backups[i]!, resolve(destinationRoot, paths[i]!));
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
