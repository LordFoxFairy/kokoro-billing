import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCanonicalSchema } from "../../scripts/canonical-schema.js";
import { verifySchema } from "../../scripts/schema-verification.js";
import { withSchemaSession } from "../../scripts/schema-database-session.js";

const adminUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!adminUrl);
const canonicalSql = await readFile(
  resolve(process.cwd(), "database/schema.sql"),
  "utf8",
);

integration("full canonical catalog drift", () => {
  let admin: Pool;
  let database: string;
  let targetUrl: string;
  beforeEach(async () => {
    database = `billing_drift_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({ connectionString: assertDefined(adminUrl), max: 1 });
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    const url = new URL(assertDefined(adminUrl));
    url.pathname = `/${database}`;
    url.search = "";
    targetUrl = url.toString();
    await installCanonicalSchema({
      databaseUrl: targetUrl,
      schemaSql: canonicalSql,
    });
  });
  afterEach(async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    } finally {
      await admin.end();
    }
  });

  async function mutate(sql: string): Promise<void> {
    const pool = new Pool({ connectionString: targetUrl, max: 1 });
    try {
      await pool.query("SET search_path=public,pg_catalog");
      await pool.query(sql);
    } finally {
      await pool.end();
    }
  }
  async function verify(url = targetUrl) {
    return verifySchema({
      databaseUrl: url,
      schemaAdminUrl: assertDefined(adminUrl),
      canonicalSql,
    });
  }

  it("accepts the canonical 35-table schema and cleans its reference database", async () => {
    const before = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'billing_reference_%' ORDER BY datname",
    );
    const result = await verify();
    expect(result.differences).toEqual([]);
    expect(result.objectCounts.relations).toBe(35);
    expect(result.canonicalSha256).toMatch(/^[a-f0-9]{64}$/u);
    const after = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'billing_reference_%' ORDER BY datname",
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("reads the target through an effective read-only role", async () => {
    const url = new URL(targetUrl);
    url.searchParams.set("options", "-c role=pg_read_all_data");
    expect((await verify(url.toString())).differences).toEqual([]);
  });

  it("reports target database locale metadata that differs from template0 defaults", async () => {
    const alternate = `billing_locale_${randomUUID().replaceAll("-", "")}`;
    await admin.query(
      `CREATE DATABASE "${alternate}" TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    const url = new URL(assertDefined(adminUrl));
    url.pathname = `/${alternate}`;
    url.search = "";
    try {
      await installCanonicalSchema({
        databaseUrl: url.toString(),
        schemaSql: canonicalSql,
      });
      const result = await verify(url.toString());
      expect(result.differences).toContainEqual(
        expect.objectContaining({
          category: "database",
          key: "database",
          kind: "changed",
        }),
      );
    } finally {
      await admin.query(`DROP DATABASE "${alternate}"`);
    }
  });

  it.each([
    [
      "missing CHECK",
      "ALTER TABLE entitlement_credit_account DROP CONSTRAINT ck_entitlement_credit_account_balances",
      "constraints",
    ],
    [
      "changed CHECK predicate",
      "ALTER TABLE entitlement_credit_account DROP CONSTRAINT ck_entitlement_credit_account_balances; ALTER TABLE entitlement_credit_account ADD CONSTRAINT ck_entitlement_credit_account_balances CHECK (available_micros >= -1 AND held_micros >= 0)",
      "constraints",
    ],
    [
      "changed type precision",
      "ALTER TABLE entitlement_credit_account ALTER COLUMN created_at TYPE timestamptz",
      "columns",
    ],
    [
      "changed default",
      "ALTER TABLE entitlement_credit_account ALTER COLUMN updated_at DROP DEFAULT",
      "columns",
    ],
    [
      "changed nullability",
      "ALTER TABLE entitlement_credit_account ALTER COLUMN updated_at DROP NOT NULL",
      "columns",
    ],
    [
      "missing column",
      "ALTER TABLE entitlement_credit_account DROP COLUMN generation",
      "columns",
    ],
    ["missing table", "DROP TABLE payment_outbox", "relations"],
    ["missing index", "DROP INDEX ix_payment_outbox_dispatch", "indexes"],
    [
      "changed partial index predicate",
      "DROP INDEX ix_payment_outbox_dispatch; CREATE INDEX ix_payment_outbox_dispatch ON payment_outbox (next_attempt_at, created_at, outbox_id) WHERE published_at IS NULL",
      "indexes",
    ],
    [
      "missing UNIQUE",
      "ALTER TABLE entitlement_credit_account DROP CONSTRAINT uq_entitlement_credit_account_subject",
      "constraints",
    ],
    ["extra table", "CREATE TABLE drift_extra(id int)", "relations"],
    [
      "extra foreign key",
      "ALTER TABLE entitlement_credit_account ADD CONSTRAINT drift_fk FOREIGN KEY (tenant_id, subject_id) REFERENCES entitlement_credit_account(tenant_id, subject_id)",
      "constraints",
    ],
    ["extra type", "CREATE TYPE drift_type AS ENUM ('x')", "types"],
    [
      "extra function",
      "CREATE FUNCTION drift_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
      "routines",
    ],
    [
      "unlogged relation",
      "ALTER TABLE entitlement_credit_account SET UNLOGGED",
      "relations",
    ],
    [
      "RLS policy",
      "ALTER TABLE entitlement_credit_account ENABLE ROW LEVEL SECURITY; CREATE POLICY drift_policy ON entitlement_credit_account USING (true)",
      "relations",
    ],
    [
      "user trigger",
      "CREATE FUNCTION drift_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER drift_trigger BEFORE INSERT ON entitlement_credit_account FOR EACH ROW EXECUTE FUNCTION drift_trigger_fn()",
      "triggers",
    ],
    [
      "user rule",
      "CREATE RULE drift_rule AS ON UPDATE TO entitlement_credit_account DO NOTHING",
      "rules",
    ],
  ])(
    "reports %s without changing target data",
    async (_label, sql, category) => {
      await mutate(
        "INSERT INTO entitlement_credit_account (credit_account_id,tenant_id,subject_id,status) VALUES ('marker','tenant','subject','active')",
      );
      await mutate(sql);
      const result = await verify();
      expect(
        result.differences.some(
          (difference) => difference.category === category,
        ),
      ).toBe(true);
      const pool = new Pool({ connectionString: targetUrl, max: 1 });
      try {
        const marker = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.entitlement_credit_account WHERE credit_account_id='marker'",
        );
        expect(marker.rows[0]?.count).toBe("1");
      } finally {
        await pool.end();
      }
    },
  );

  it("rejects invalid target schema configuration before connecting", async () => {
    await expect(
      verifySchema({
        databaseUrl: "postgresql://x@127.0.0.1:1/x?schema=private",
        schemaAdminUrl: assertDefined(adminUrl),
        canonicalSql,
      }),
    ).rejects.toThrow(/schema must be public/iu);
  });

  it("does not execute a target-defined system-function shadow during identity checks", async () => {
    await mutate(
      "CREATE TABLE identity_marker(value int); CREATE FUNCTION public.current_setting(text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.identity_marker VALUES (1); RETURN 'shadow'; END $$",
    );
    const url = new URL(targetUrl);
    url.searchParams.set("options", "-c search_path=public,pg_catalog");
    await verify(url.toString());
    const pool = new Pool({ connectionString: targetUrl, max: 1 });
    try {
      expect(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.identity_marker",
          )
        ).rows[0]?.count,
      ).toBe("0");
    } finally {
      await pool.end();
    }
  });

  it("contains checked-out backend termination as a controlled session failure", async () => {
    const marker = `drift_terminate_${randomUUID().replaceAll("-", "")}`;
    const pending = withSchemaSession(
      targetUrl,
      async (query) => {
        await query("SET statement_timeout='5s'");
        await query(`SELECT pg_sleep(10) /* ${marker} */`);
      },
      2_000,
    );
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100 && pid === undefined; attempt += 1) {
      const row = await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND query LIKE $2",
        [database, `%${marker}%`],
      );
      pid = row.rows[0]?.pid;
      if (pid === undefined)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid).toBeDefined();
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await expect(pending).rejects.toThrow(
      /terminating connection|connection terminated/iu,
    );
  });

  it("bounds a stalled client query and destroys its session", async () => {
    const started = Date.now();
    await expect(
      withSchemaSession(
        targetUrl,
        async (query) => {
          await query("SET statement_timeout='5s'");
          await query("SELECT pg_sleep(2)");
        },
        100,
      ),
    ).rejects.toThrow(/query exceeded 100ms/iu);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await verify()).differences).toEqual([]);
  });

  it("does not let work suppress a fatal query deadline and reuse the released client", async () => {
    await expect(
      withSchemaSession(
        targetUrl,
        async (query) => {
          await query("SET statement_timeout='5s'");
          await query("SELECT pg_sleep(2)").catch(() => undefined);
          await query("SELECT 1").catch(() => undefined);
        },
        100,
      ),
    ).rejects.toThrow(/query exceeded 100ms/iu);
  });

  it("closes its pool when connection acquisition fails", async () => {
    const started = Date.now();
    await expect(
      withSchemaSession(
        "postgresql://fixture@127.0.0.1:1/fixture",
        async () => Promise.resolve(undefined),
        100,
      ),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([undefined, null, false, 0, ""])(
    "preserves the exact falsey rejection %j from session work",
    async (reason) => {
      const rejectWork = (failure: unknown): Promise<never> =>
        Promise.resolve().then(() => {
          throw failure;
        });
      await expect(
        withSchemaSession(targetUrl, () => rejectWork(reason)),
      ).rejects.toBe(reason);
    },
  );
});
