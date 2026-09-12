import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withCanonicalReference } from "../../scripts/canonical-reference.js";

export type UsageHoldDatabaseFixture = {
  readonly url: string;
  close(): Promise<void>;
};

export async function createUsageHoldDatabaseFixture(
  adminUrl: string,
): Promise<UsageHoldDatabaseFixture> {
  const sql = await readFile(resolve("database/schema.sql"), "utf8");
  let release!: () => void;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  let ready!: (url: string) => void;
  let rejectReady!: (error: unknown) => void;
  const initialized = new Promise<string>((resolveReady, reject) => {
    ready = resolveReady;
    rejectReady = reject;
  });
  const lifecycle = withCanonicalReference(adminUrl, sql, async (url) => {
    ready(url);
    await released;
  });
  void lifecycle.catch(rejectReady);
  const installedUrl = new URL(await initialized);
  installedUrl.searchParams.set("options", "-c search_path=public,pg_catalog");
  const url = installedUrl.toString();
  let closed = false;
  return {
    url,
    async close() {
      if (closed) return;
      closed = true;
      release();
      await lifecycle;
    },
  };
}
