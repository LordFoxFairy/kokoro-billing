import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { installCanonicalSchema } from "../../scripts/canonical-schema.js";
import { withCanonicalReference } from "../../scripts/canonical-reference.js";
import {
  generateArtifacts,
  temporaryGenerationRoot,
} from "../../scripts/prisma-generation.js";
import { comparePrismaArtifacts } from "../../scripts/prisma-artifacts.js";
const adminUrl = process.env.SCHEMA_ADMIN_URL;
const integration = describe.skipIf(!adminUrl);
integration("generated Prisma Client", () => {
  let admin: Pool;
  let database: string;
  let url: string;
  beforeAll(async () => {
    database = `billing_prisma_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({ connectionString: assertDefined(adminUrl), max: 1 });
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    const parsed = new URL(assertDefined(adminUrl));
    parsed.pathname = `/${database}`;
    url = parsed.toString();
    await installCanonicalSchema({
      databaseUrl: url,
      schemaSql: await readFile("database/schema.sql", "utf8"),
    });
  });
  afterAll(async () => {
    try {
      await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      await admin.end();
    }
  });
  it("rebuilds identical isolated artifacts and detects untouched drift", async () => {
    const sql = await readFile("database/schema.sql", "utf8");
    const expectedRoot = await temporaryGenerationRoot();
    const actualRoot = await temporaryGenerationRoot();
    try {
      await withCanonicalReference(
        assertDefined(adminUrl),
        sql,
        async (referenceUrl) =>
          generateArtifacts(referenceUrl, sql, expectedRoot),
      );
      await withCanonicalReference(
        assertDefined(adminUrl),
        sql,
        async (referenceUrl) =>
          generateArtifacts(referenceUrl, sql, actualRoot),
      );

      expect(await comparePrismaArtifacts(expectedRoot, actualRoot)).toEqual({
        missing: [],
        extra: [],
        changed: [],
      });
      expect(
        (
          await readFile(
            resolve(actualRoot, "database/generated/schema.prisma"),
            "utf8",
          )
        ).match(/^model /gmu),
      ).toHaveLength(35);

      const schemaPath = resolve(
        actualRoot,
        "database/generated/schema.prisma",
      );
      const clientPath = resolve(actualRoot, "src/generated/prisma/client.ts");
      const missingPath = resolve(
        actualRoot,
        "src/generated/prisma/browser.ts",
      );
      const extraPath = resolve(actualRoot, "src/generated/prisma/extra.ts");
      const schemaTamper = `${await readFile(schemaPath, "utf8")}\n// schema tamper\n`;
      const clientTamper = `${await readFile(clientPath, "utf8")}\n// client tamper\n`;
      await writeFile(schemaPath, schemaTamper);
      await writeFile(clientPath, clientTamper);
      await unlink(missingPath);
      await writeFile(extraPath, "export const extra = true;\n");

      const differences = await comparePrismaArtifacts(
        expectedRoot,
        actualRoot,
      );
      expect(differences.changed).toEqual(
        expect.arrayContaining([
          "database/generated/schema.prisma",
          "src/generated/prisma/client.ts",
        ]),
      );
      expect(differences.missing).toContain("src/generated/prisma/browser.ts");
      expect(differences.extra).toContain("src/generated/prisma/extra.ts");
      expect(await readFile(schemaPath, "utf8")).toBe(schemaTamper);
      expect(await readFile(clientPath, "utf8")).toBe(clientTamper);
    } finally {
      await Promise.all([
        rm(expectedRoot, { recursive: true, force: true }),
        rm(actualRoot, { recursive: true, force: true }),
      ]);
    }
  });
  it("uses the generated source Client against canonical PostgreSQL", async () => {
    const pool = new Pool({ connectionString: url, max: 2 });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    try {
      expect(await prisma.entitlement_credit_account.count()).toBe(0);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("rejects a non-public admin schema before attempting a connection", async () => {
    await expect(
      withCanonicalReference(
        "postgresql://fixture@127.0.0.1:1/postgres?schema=public&schema=private",
        "SELECT 1",
        async () => Promise.resolve(undefined),
      ),
    ).rejects.toThrow(/schema parameters must all be public/iu);
  });
});
