import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { withCanonicalReference } from "../../scripts/canonical-reference.js";

export type PrismaDatabaseFixture = {
  client: PrismaClient;
  pool: Pool;
  url: string;
  close(): Promise<void>;
};

export async function createPrismaDatabaseFixture(
  adminUrl: string,
): Promise<PrismaDatabaseFixture> {
  const sql = await readFile(resolve("database/schema.sql"), "utf8");
  let release!: () => void;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  let ready!: (fixture: Omit<PrismaDatabaseFixture, "close">) => void;
  let rejectReady!: (error: unknown) => void;
  const initialized = new Promise<Omit<PrismaDatabaseFixture, "close">>(
    (resolveReady, rejectInitialized) => {
      ready = resolveReady;
      rejectReady = rejectInitialized;
    },
  );
  const lifecycle = withCanonicalReference(adminUrl, sql, async (url) => {
    const pool = new Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 2_000,
      options:
        "-c search_path=public,pg_catalog -c timezone=UTC -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000",
    });
    const client = new PrismaClient({ adapter: new PrismaPg(pool) });
    let primaryError: unknown;
    let hasPrimaryError = false;
    try {
      await client.$queryRaw`SELECT 1`;
      ready({ client, pool, url });
      await released;
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    }
    const cleanupErrors: unknown[] = [];
    await client
      .$disconnect()
      .catch((error: unknown) => cleanupErrors.push(error));
    await pool.end().catch((error: unknown) => cleanupErrors.push(error));
    if (cleanupErrors.length)
      throw new AggregateError(
        hasPrimaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
        "Prisma fixture cleanup failed",
        hasPrimaryError ? { cause: primaryError } : undefined,
      );
    if (hasPrimaryError) throw primaryError;
  });
  void lifecycle.catch(rejectReady);
  let fixture: Omit<PrismaDatabaseFixture, "close">;
  try {
    fixture = await initialized;
  } catch (error) {
    await lifecycle.catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    ...fixture,
    async close() {
      if (closed) return;
      closed = true;
      release();
      await lifecycle;
    },
  };
}
