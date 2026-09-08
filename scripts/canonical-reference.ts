import { randomUUID } from "node:crypto";
import { installCanonicalSchema } from "./canonical-schema.js";
import { withSchemaSession } from "./schema-database-session.js";
import { SchemaVerificationResourceError } from "./schema-verification.error.js";

export async function withCanonicalReference<T>(
  adminUrlRaw: string,
  canonicalSql: string,
  work: (databaseUrl: string) => Promise<T>,
): Promise<T> {
  const adminUrl = new URL(adminUrlRaw);
  if (!["postgres:", "postgresql:"].includes(adminUrl.protocol))
    throw new Error("SCHEMA_ADMIN_URL must be PostgreSQL");
  if (
    adminUrl.searchParams.getAll("schema").some((schema) => schema !== "public")
  )
    throw new Error("SCHEMA_ADMIN_URL schema parameters must all be public");
  const name = `billing_reference_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let result: T | undefined;
  let primary: unknown;
  let failed = false;
  let cleanup: unknown;
  let cleanupFailed = false;
  try {
    await withSchemaSession(adminUrl.toString(), async (query) => {
      try {
        await query(`CREATE DATABASE "${name}" TEMPLATE template0`);
        created = true;
      } catch (error) {
        throw new SchemaVerificationResourceError(
          name,
          "creation-unconfirmed",
          { cause: error },
        );
      }
    });
    const reference = new URL(adminUrl);
    reference.pathname = `/${name}`;
    reference.searchParams.delete("schema");
    reference.searchParams.delete("options");
    await installCanonicalSchema({
      databaseUrl: reference.toString(),
      schemaSql: canonicalSql,
    });
    result = await work(reference.toString());
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    if (created)
      try {
        await withSchemaSession(adminUrl.toString(), (query) =>
          query(`DROP DATABASE "${name}"`).then(() => undefined),
        );
      } catch (error) {
        cleanup = error;
        cleanupFailed = true;
      }
  }
  if (cleanupFailed)
    throw new SchemaVerificationResourceError(name, "cleanup-failed", {
      cause: failed
        ? new AggregateError(
            [primary, cleanup],
            "reference work and cleanup failed",
          )
        : cleanup,
    });
  if (failed) throw primary;
  return result!;
}
