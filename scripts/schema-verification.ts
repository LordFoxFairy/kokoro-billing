import { createHash } from "node:crypto";
import { withCanonicalReference } from "./canonical-reference.js";
import { readSchemaCatalog } from "./schema-catalog.js";
import {
  withSchemaSession,
  type CatalogQuery,
} from "./schema-database-session.js";
import type {
  CatalogDifference,
  SchemaCatalog,
  SchemaVerificationResult,
} from "./schema-catalog.types.js";

const categories = [
  "database",
  "relations",
  "columns",
  "constraints",
  "indexes",
  "types",
  "routines",
  "triggers",
  "rules",
  "policies",
] as const;

export function compareSchemaCatalogs(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
): CatalogDifference[] {
  const differences: CatalogDifference[] = [];
  for (const category of categories) {
    const left = new Map(
      expected[category].map((item) => [item.key, item.definition]),
    );
    const right = new Map(
      actual[category].map((item) => [item.key, item.definition]),
    );
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const wanted = left.get(key);
      const found = right.get(key);
      if (!left.has(key))
        differences.push({ category, key, kind: "unexpected", actual: found! });
      else if (!right.has(key))
        differences.push({ category, key, kind: "missing", expected: wanted! });
      else if (wanted !== found)
        differences.push({
          category,
          key,
          kind: "changed",
          expected: wanted!,
          actual: found!,
        });
    }
  }
  return differences;
}

function checkedUrl(raw: string, name: string): URL {
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error(`${name} must be PostgreSQL`);
  if (url.searchParams.getAll("schema").some((value) => value !== "public"))
    throw new Error(`${name} schema must be public`);
  return url;
}

async function snapshot(url: string): Promise<SchemaCatalog> {
  return withSchemaSession(url, async (query) => {
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await query(
        "SELECT pg_catalog.set_config('search_path','public,pg_catalog',true), pg_catalog.set_config('TimeZone','UTC',true)",
      );
      const catalog = await readSchemaCatalog(query);
      await query("COMMIT");
      return catalog;
    } catch (error) {
      await query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

async function identity(
  client: CatalogQuery,
): Promise<{ address: string; port: number; version: string }> {
  const result = await client<{
    address: string;
    port: number;
    version: string;
  }>(
    "SELECT COALESCE(pg_catalog.inet_server_addr()::pg_catalog.text,'local') AS address, pg_catalog.inet_server_port() AS port, pg_catalog.current_setting('server_version_num') AS version",
  );
  const row = result.rows[0];
  if (!row) throw new Error("database server identity unavailable");
  return row;
}

async function readOnlyIdentity(
  url: string,
): Promise<{ address: string; port: number; version: string }> {
  return withSchemaSession(url, async (query) => {
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await query(
        "SELECT pg_catalog.set_config('search_path','pg_catalog,public',true), pg_catalog.set_config('TimeZone','UTC',true)",
      );
      const value = await identity(query);
      await query("COMMIT");
      return value;
    } catch (error) {
      await query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

export async function verifySchema(input: {
  databaseUrl: string;
  schemaAdminUrl: string;
  canonicalSql: string;
}): Promise<SchemaVerificationResult> {
  const targetUrl = checkedUrl(input.databaseUrl, "DATABASE_URL");
  const adminUrl = checkedUrl(input.schemaAdminUrl, "SCHEMA_ADMIN_URL");
  if (
    targetUrl.hostname !== adminUrl.hostname ||
    (targetUrl.port || "5432") !== (adminUrl.port || "5432")
  )
    throw new Error("target and admin URLs must identify the same server");
  await withSchemaSession(adminUrl.toString(), async (adminQuery) => {
    const a = await identity(adminQuery);
    const b = await readOnlyIdentity(targetUrl.toString());
    if (a.address !== b.address || a.port !== b.port || a.version !== b.version)
      throw new Error(
        "target and admin connections resolved to different servers",
      );
  });
  return withCanonicalReference(
    adminUrl.toString(),
    input.canonicalSql,
    async (referenceUrl) => {
      const expected = await snapshot(referenceUrl);
      const actual = await snapshot(targetUrl.toString());
      return {
        canonicalSha256: createHash("sha256")
          .update(input.canonicalSql)
          .digest("hex"),
        serverVersion: actual.serverVersion,
        objectCounts: Object.fromEntries(
          categories.map((category) => [category, actual[category].length]),
        ) as SchemaVerificationResult["objectCounts"],
        differences: compareSchemaCatalogs(expected, actual),
      };
    },
  );
}
