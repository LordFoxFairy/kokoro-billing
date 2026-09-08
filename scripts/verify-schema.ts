import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifySchema } from "./schema-verification.js";
import { safeSchemaVerificationErrorMessage } from "./schema-verification.error.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const schemaAdminUrl = process.env.SCHEMA_ADMIN_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!schemaAdminUrl) throw new Error("SCHEMA_ADMIN_URL is required");
  const canonicalSql = await readFile(
    resolve(process.cwd(), "database/schema.sql"),
    "utf8",
  );
  const result = await verifySchema({
    databaseUrl,
    schemaAdminUrl,
    canonicalSql,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.differences.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(safeSchemaVerificationErrorMessage(error));
  process.exitCode = 1;
}
