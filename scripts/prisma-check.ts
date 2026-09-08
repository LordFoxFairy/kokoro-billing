import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { withCanonicalReference } from "./canonical-reference.js";
import {
  generateArtifacts,
  temporaryGenerationRoot,
} from "./prisma-generation.js";
import { comparePrismaArtifacts } from "./prisma-artifacts.js";
import { safeSchemaVerificationErrorMessage } from "./schema-verification.error.js";

async function main(): Promise<void> {
  const admin = process.env.SCHEMA_ADMIN_URL;
  if (!admin) throw new Error("SCHEMA_ADMIN_URL is required");
  const sql = await readFile(resolve("database/schema.sql"), "utf8");
  const staging = await temporaryGenerationRoot();
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    await withCanonicalReference(admin, sql, async (url) =>
      generateArtifacts(url, sql, staging),
    );
    const differences = await comparePrismaArtifacts(staging, process.cwd());
    const changed = [
      ...differences.missing,
      ...differences.extra,
      ...differences.changed,
    ];
    if (changed.length) {
      console.error(
        `generated Prisma artifacts differ: ${changed.sort().join(", ")}`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  try {
    await rm(staging, { recursive: true, force: true });
  } catch (cleanupError) {
    throw hasPrimaryError
      ? new AggregateError(
          [primaryError, cleanupError],
          "Prisma check and staging cleanup failed",
          { cause: primaryError },
        )
      : cleanupError;
  }
  if (hasPrimaryError) throw primaryError;
}

try {
  await main();
} catch (error) {
  console.error(safeSchemaVerificationErrorMessage(error));
  process.exitCode = 1;
}
