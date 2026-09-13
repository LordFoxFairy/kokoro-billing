import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCanonicalSchema } from "../../scripts/canonical-schema.js";

const managementUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!managementUrl);
const canonicalSql = await readFile(
  resolve(process.cwd(), "database/schema.sql"),
  "utf8",
);

function databaseUrl(database: string, query = ""): string {
  const url = new URL(assertDefined(managementUrl));
  url.pathname = `/${database}`;
  url.search = query;
  return url.toString();
}

integration("canonical schema installation", () => {
  let admin: Pool;
  let database: string;

  beforeEach(async () => {
    database = `billing_schema_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({
      connectionString: assertDefined(managementUrl),
      max: 1,
    });
    await admin.query(`CREATE DATABASE "${database}"`);
  });

  afterEach(async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    } finally {
      await admin.end();
    }
  });

  const install = (
    url = databaseUrl(database),
    sql = canonicalSql,
    lockTimeoutMs = 1_000,
    clientQueryTimeoutMs = 12_000,
  ) =>
    installCanonicalSchema({
      databaseUrl: url,
      schemaSql: sql,
      lockTimeoutMs,
      statementTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 10_000,
      clientQueryTimeoutMs,
      closeTimeoutMs: 2_000,
    });

  async function inTarget(sql: string): Promise<void> {
    const pool = new Pool({ connectionString: databaseUrl(database), max: 1 });
    try {
      await pool.query(sql);
    } finally {
      await pool.end();
    }
  }

  async function expectNoPartialTable(): Promise<void> {
    const pool = new Pool({ connectionString: databaseUrl(database), max: 1 });
    try {
      const result = await pool.query<{ relation: string | null }>(
        "SELECT pg_catalog.to_regclass('public.partial')::text AS relation",
      );
      expect(result.rows[0]?.relation).toBeNull();
    } finally {
      await pool.end();
    }
  }

  it("installs exactly 32 canonical tables and rejects a repeat installation", async () => {
    await install();
    const pool = new Pool({ connectionString: databaseUrl(database), max: 1 });
    try {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')",
      );
      expect(result.rows[0]?.count).toBe("32");
    } finally {
      await pool.end();
    }
    await expect(install()).rejects.toThrow(/non-empty/iu);
  });

  it.each([
    [
      "non-public table",
      "CREATE SCHEMA occupied; CREATE TABLE occupied.item(id int)",
    ],
    ["public view", "CREATE VIEW public.item AS SELECT 1 AS id"],
    ["public sequence", "CREATE SEQUENCE public.item_seq"],
    [
      "public materialized view",
      "CREATE MATERIALIZED VIEW public.item AS SELECT 1 AS id",
    ],
    [
      "public foreign table",
      "CREATE EXTENSION file_fdw WITH SCHEMA pg_catalog; CREATE SERVER fixture FOREIGN DATA WRAPPER file_fdw; CREATE FOREIGN TABLE public.item(id int) SERVER fixture OPTIONS (filename '/tmp/billing-fixture')",
    ],
    ["enum", "CREATE TYPE public.item AS ENUM ('one')"],
    ["domain", "CREATE DOMAIN public.item AS text"],
    ["composite", "CREATE TYPE public.item AS (id int)"],
    [
      "function",
      "CREATE FUNCTION public.item() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    ],
    [
      "procedure",
      "CREATE PROCEDURE public.item() LANGUAGE sql AS $$ SELECT 1 $$",
    ],
    ["range", "CREATE TYPE public.item AS RANGE (subtype = integer)"],
  ])("rejects %s in an otherwise fresh database", async (_name, sql) => {
    await inTarget(sql);
    await expect(install()).rejects.toThrow(/non-empty/iu);
    const pool = new Pool({ connectionString: databaseUrl(database), max: 1 });
    try {
      const original = await pool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM (
          SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
          UNION ALL SELECT t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
          UNION ALL SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        ) objects WHERE name IN ('item', 'item_seq')
      `);
      expect(Number(original.rows[0]?.count)).toBeGreaterThan(0);
      const billing = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relname LIKE 'billing_%' OR c.relname LIKE 'billing_%')",
      );
      expect(billing.rows[0]?.count).toBe("0");
    } finally {
      await pool.end();
    }
  });

  it("rejects every non-public schema URL value before connecting", async () => {
    const unreachable = "postgresql://fixture@127.0.0.1:1/fixture";
    await expect(
      install(`${unreachable}?schema=public&schema=private`),
    ).rejects.toThrow(/schema.*public/iu);
    await expect(
      install(`${unreachable}?schema=private&schema=public`),
    ).rejects.toThrow(/schema.*public/iu);
    await expect(install(`${unreachable}?schema=private`)).rejects.toThrow(
      /schema.*public/iu,
    );
  });

  it("requires the public schema to exist", async () => {
    await inTarget("DROP SCHEMA public");
    await expect(install()).rejects.toThrow(/public schema.*exist/iu);
  });

  it("verifies CREATE privilege using the effective connection role", async () => {
    const options = encodeURIComponent("-c role=pg_read_all_data");
    await expect(
      install(databaseUrl(database, `?options=${options}`)),
    ).rejects.toThrow(/CREATE privilege/iu);
  });

  it("overrides URI options search_path and installs only in public", async () => {
    await inTarget("CREATE SCHEMA route_elsewhere");
    const options = encodeURIComponent("-c search_path=route_elsewhere");
    await install(databaseUrl(database, `?schema=public&options=${options}`));
    const pool = new Pool({ connectionString: databaseUrl(database), max: 1 });
    try {
      const result = await pool.query<{ schema_name: string }>(
        "SELECT DISTINCT n.nspname AS schema_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'billing_%' OR c.relname LIKE 'billing_%'",
      );
      expect(result.rows.map((row) => row.schema_name)).toEqual(["public"]);
    } finally {
      await pool.end();
    }
  });

  it("rolls back a mid-DDL failure and permits a later canonical installation", async () => {
    await expect(
      install(
        undefined,
        "CREATE TABLE public.first(id int); SELECT missing_function();",
      ),
    ).rejects.toThrow();
    await install();
  });

  it("serializes two independent installers so one succeeds and one rejects non-empty", async () => {
    const results = await Promise.allSettled([install(), install()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status === "rejected")
      expect(String(rejected.reason)).toMatch(/non-empty/iu);
  });

  it("fails within the lock budget and releases its client", async () => {
    const blocker = new Pool({
      connectionString: databaseUrl(database),
      max: 1,
    });
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('kokoro-billing:canonical-schema', 0))",
      );
      const started = Date.now();
      await expect(install(undefined, canonicalSql, 100)).rejects.toThrow(
        /lock timeout|canceling statement/iu,
      );
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
    await install();
  });

  it("turns a terminated checked-out backend into a controlled rejection and recovers", async () => {
    const marker = `billing_terminate_${randomUUID().replaceAll("-", "")}`;
    const pending = install(
      undefined,
      `CREATE TABLE public.partial(id int); SELECT pg_sleep(10) /* ${marker} */`,
    );
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100 && pid === undefined; attempt += 1) {
      const activity = await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND query LIKE $2 AND pid <> pg_backend_pid()",
        [database, `%${marker}%`],
      );
      pid = activity.rows[0]?.pid;
      if (pid === undefined)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid).toBeDefined();
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await expect(pending).rejects.toThrow(
      /terminating connection|connection terminated/iu,
    );
    await expectNoPartialTable();
    await install();
  });

  it("destroys and releases a client when the JavaScript query deadline expires", async () => {
    await expect(
      install(
        undefined,
        "CREATE TABLE public.partial(id int); SELECT pg_sleep(1)",
        1_000,
        100,
      ),
    ).rejects.toThrow(/query exceeded 100ms/iu);
    await expectNoPartialTable();
    await install();
  });
});
