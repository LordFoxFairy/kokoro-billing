import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { createPostgresReconciliationService } from "../../src/infrastructure/postgres/create-postgres-services.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  createBillingConnection,
  runWithBillingContext,
} from "../../src/infrastructure/postgres/connection.js";
import type { SqlConnection } from "../../src/infrastructure/postgres/database.js";

const url = process.env.DATABASE_URL;
assert(url);
const scenario = process.argv[2];
const connection = await createBillingConnection(url);
const observer = await createBillingConnection(url);
const ownPids = new Set<number>();

async function backend(connection: SqlConnection): Promise<number> {
  const [rows] = await connection.query<{ pid: number }[]>(
    "SELECT pg_catalog.pg_backend_pid() AS pid",
  );
  const row = rows[0];
  assert(row);
  ownPids.add(row.pid);
  return row.pid;
}

async function terminateOwnBackend(pid: number) {
  assert(ownPids.has(pid));
  const [rows] = await observer.query<{ datname: string }[]>(
    "SELECT datname FROM pg_catalog.pg_stat_activity WHERE pid = $1",
    [pid],
  );
  assert.equal(rows[0]?.datname, new URL(url ?? "").pathname.slice(1));
  const [terminated] = await observer.query<{ terminated: boolean }[]>(
    "SELECT pg_catalog.pg_terminate_backend(pid) AS terminated FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND datname = pg_catalog.current_database()",
    [pid],
  );
  assert.equal(terminated[0]?.terminated, true);
}

// Deliberately accepts arbitrary rejection values to verify exact error identity through cleanup.
function injectFailure(failure: unknown): never {
  throw failure;
}

function actualPool(): Pool {
  const pool: unknown = Reflect.get(connection, "pool");
  assert(pool instanceof Pool);
  return pool;
}

async function controlFailure(command: string) {
  const pool = actualPool();
  const restores: (() => void)[] = [];
  let injected = false;
  let queryFailure: unknown;
  let faulted: PoolClient | undefined;
  let releases = 0;
  let calls = 0;
  const onRelease = (_error: unknown, client: PoolClient) => {
    if (client === faulted) releases += 1;
  };
  const onAcquire = (client: PoolClient) => {
    if (injected || faulted) return;
    faulted = client;
    const original = client.query.bind(client);
    const descriptor = Object.getOwnPropertyDescriptor(client, "query");
    // Dynamic driver boundary: forward all original arguments/results without an overloaded-type cast.
    Object.defineProperty(client, "query", {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]): Promise<unknown> => {
        if (args[0] === command) {
          calls += 1;
          if (!injected) {
            injected = true;
            const pid: unknown = Reflect.get(client, "processID");
            assert(typeof pid === "number");
            ownPids.add(pid);
            oldPid = pid;
            await terminateOwnBackend(pid);
            await delay(100);
          }
        }
        try {
          const result: unknown = Reflect.apply(original, client, args);
          return await result;
        } catch (error) {
          if (args[0] === command) queryFailure = error;
          throw error;
        }
      },
    });
    restores.push(() => {
      if (descriptor) Object.defineProperty(client, "query", descriptor);
      else Reflect.deleteProperty(client, "query");
    });
  };
  pool.on("acquire", onAcquire);
  pool.on("release", onRelease);
  const primary = new Error("fixture business error before rollback");
  let caught = false;
  try {
    try {
      await runWithBillingContext(() =>
        connection.withTransaction(async () => {
          await backend(connection);
          if (command === "ROLLBACK") throw primary;
        }),
      );
    } catch (error) {
      caught = true;
      assert.equal(error, command === "ROLLBACK" ? primary : queryFailure);
    }
    assert(caught);
    assert(injected);
    assert(queryFailure instanceof Error);
    assert.equal(calls, 1, "no control-command retry");
    assert.equal(releases, 1, "release exactly once after control failure");
    assert.equal(
      pool.totalCount,
      0,
      "failed client was destroyed, not recycled",
    );
  } finally {
    pool.off("acquire", onAcquire);
    pool.off("release", onRelease);
    for (const restore of restores) restore();
  }
}

let oldPid: number | undefined;
try {
  if (scenario === "checked-out-idle") {
    await assert.rejects(
      runWithBillingContext(() =>
        connection.withTransaction(async () => {
          oldPid = await backend(connection);
          await connection.query(
            "SELECT pg_catalog.set_config('idle_in_transaction_session_timeout', '40ms', true)",
          );
          await delay(500);
          await connection.query("SELECT 1");
        }),
      ),
      { code: "25P03" },
    );
  } else if (scenario === "idle-pool") {
    oldPid = await backend(connection);
    await terminateOwnBackend(oldPid);
    await delay(100);
  } else if (scenario === "nested-fatal") {
    await assert.rejects(
      runWithBillingContext(() =>
        connection.withTransaction(async () => {
          oldPid = await backend(connection);
          let primary: unknown;
          await assert.rejects(
            connection.withTransaction(async () => {
              await terminateOwnBackend(await backend(connection));
              await delay(100);
              try {
                await connection.query("SELECT 1");
              } catch (error) {
                primary = error;
                throw error;
              }
            }),
            { code: "57P01" },
          );
          // Inner cleanup must leave the outer transaction poisoned, never autocommit.
          for (const work of [
            () => connection.query("SELECT 1"),
            () => connection.execute("SELECT 1"),
            () => connection.beginTransaction(),
          ]) {
            await assert.rejects(work(), (error) => {
              assert.equal(error, primary);
              return true;
            });
          }
        }),
      ),
      { code: "57P01" },
    );
  } else if (scenario === "report-idle") {
    oldPid = await backend(connection);
    await connection.query(
      "SELECT pg_catalog.set_config('idle_in_transaction_session_timeout', '40ms', false)",
    );
    const observed: SqlConnection = {
      query: async <T>(
        sql: string,
        values?: unknown[],
      ): Promise<[T, unknown[]]> => {
        const result = await connection.query<T>(sql, values);
        if (sql.includes("FROM entitlement_credit_account a")) await delay(500);
        return result;
      },
      execute: connection.execute.bind(connection),
      beginTransaction: connection.beginTransaction.bind(connection),
      commit: connection.commit.bind(connection),
      rollback: connection.rollback.bind(connection),
      withTransaction: connection.withTransaction.bind(connection),
      ping: connection.ping.bind(connection),
      end: connection.end.bind(connection),
    };
    await assert.rejects(
      createPostgresReconciliationService(observed).run(randomUUID()),
      { code: "25P03" },
    );
  } else if (scenario?.startsWith("control-")) {
    await controlFailure(scenario.slice("control-".length));
  } else if (scenario === "primary-falsey") {
    for (const primary of [
      undefined,
      null,
      false,
      0,
      "",
      new Error("primary business failure"),
    ]) {
      let caught = false;
      try {
        await runWithBillingContext(() =>
          connection.withTransaction(async () => {
            oldPid = await backend(connection);
            await terminateOwnBackend(oldPid);
            await delay(100);
            injectFailure(primary);
          }),
        );
      } catch (error) {
        caught = true;
        assert.equal(error, primary);
      }
      assert(caught);
      assert.equal(actualPool().totalCount, 0);
    }
  } else if (scenario === "listener-lifecycle") {
    const pool = actualPool();
    const clients = new Set<PoolClient>();
    const sentinel = () => undefined;
    const onConnect = (client: PoolClient) => {
      clients.add(client);
      client.on("error", sentinel);
    };
    let releases = 0;
    const onRelease = () => {
      releases += 1;
    };
    pool.on("connect", onConnect);
    pool.on("release", onRelease);
    try {
      for (let index = 0; index < 3; index += 1) {
        await runWithBillingContext(() =>
          connection.withTransaction(async () => {
            await backend(connection);
            for (const client of clients)
              assert.equal(client.listenerCount("error"), 2);
            await connection.withTransaction(() =>
              connection.query("SELECT 1"),
            );
          }),
        );
        assert.equal(releases, index + 1);
        for (const client of clients) {
          assert(client.listeners("error").includes(sentinel));
          assert.equal(
            client.listenerCount("error"),
            2,
            "one sentinel plus pg-pool idle listener",
          );
        }
      }
      assert.equal(
        clients.size,
        1,
        "healthy checkout reused without listener accumulation",
      );
    } finally {
      pool.off("connect", onConnect);
      pool.off("release", onRelease);
      for (const client of clients) client.off("error", sentinel);
    }
  } else throw new Error("unknown connection fixture scenario");
  const freshPid = await runWithBillingContext(() =>
    connection.withTransaction(() => backend(connection)),
  );
  assert.notEqual(freshPid, oldPid);
  console.log(
    JSON.stringify({ scenario, ownedBackendPids: [...ownPids], freshPid }),
  );
  console.log(`completed:${scenario}`);
} finally {
  await Promise.all([connection.end(), observer.end()]);
}
