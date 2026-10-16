import { request as httpRequest } from "node:http";
import "reflect-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import { CreditModule } from "../../src/modules/credit/credit.module.js";
import { CreditService } from "../../src/modules/credit/credit.service.js";
import { createPrismaDatabaseFixture } from "./prisma-database.fixture.js";

const admin = process.env.SCHEMA_ADMIN_URL;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function availablePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture TCP port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Billing fixture shutdown deadline"));
        }, 8_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundPort(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing owned port");
  return address.port;
}
async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function failureChild(
  entry: "source" | "dist",
  databaseUrl: string,
  port: number,
) {
  const secrets = [randomUUID(), randomUUID(), randomUUID()];
  const child = spawn(
    process.execPath,
    entry === "source"
      ? ["--import", "tsx", "src/main.ts"]
      : ["dist/src/main.js"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        BILLING_AUTH_MODE: "jwks",
        BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
        BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
        BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
        INTERNAL_SERVICE_SECRET: secrets[0],
        BILLING_BFF_SERVICE_TOKEN: secrets[1],
        BILLING_OPERATOR_PROXY_SECRET: secrets[2],
        BILLING_HOST: "127.0.0.1",
        BILLING_PORT: String(port),
        BILLING_SHUTDOWN_DEADLINE_MS: "5000",
        BILLING_ENABLED_PROVIDERS: "",
        NODE_ENV: "test",
      },
    },
  );
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    logs += String(chunk);
  });
  return { child, secrets, logs: () => logs };
}
async function boundedFailure(child: ChildProcess) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      once(child, "close"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Startup failure exceeded deadline"));
        }, 10_000);
      }),
    ]);
    expect(result).toEqual([1, null]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function listenerReply(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(1_000, () =>
    socket.destroy(new Error("Owned listener deadline")),
  );
  let reply = "";
  socket.on("data", (chunk) => {
    reply += String(chunk);
  });
  try {
    await once(socket, "end");
    return reply;
  } finally {
    socket.destroy();
  }
}

describe.skipIf(admin === undefined)(
  "normal source/dist Billing composition",
  () => {
    it.each(["source", "dist"] as const)(
      "serves canonical read facts with zero writes and drains %s entry",
      async (entry) => {
        if (!admin) throw new Error("SCHEMA_ADMIN_URL required");
        const fixture = await createPrismaDatabaseFixture(admin);
        let child: ChildProcess | undefined;
        try {
          const module = await Test.createTestingModule({
            imports: [
              DatabaseModule.register({ databaseUrl: fixture.url }),
              CreditModule,
            ],
          }).compile();
          await module.init();
          const tenant = randomUUID(),
            subject = randomUUID(),
            id = randomUUID();
          try {
            await module.get(CreditService).grant({
              tenantId: tenant,
              subjectId: subject,
              actorId: "runtime-fixture",
              amountMicros: 9007199254740993n,
              reason: "Allocate isolated runtime read fixture credits",
              sourceKind: "fixture",
              sourceRef: id,
              programKey: "runtime-fixture",
              effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
              idempotencyKey: id,
              commandIdentity: id,
            });
          } finally {
            await module.close();
          }
          const facts = async () => {
            const tables = await fixture.pool.query<{ name: string }>(
              "SELECT tablename AS name FROM pg_tables WHERE schemaname='kokoro_billing' ORDER BY tablename",
            );
            expect(tables.rows).toHaveLength(35);
            return Promise.all(
              tables.rows.map(async ({ name }) => {
                if (!/^[a-z][a-z0-9_]*$/u.test(name))
                  throw new Error("Invalid owner fixture table");
                const rows = await fixture.pool.query<{ row: string }>(
                  `SELECT to_jsonb(t)::text AS row FROM kokoro_billing."${name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
                );
                return { name, rows: rows.rows };
              }),
            );
          };
          const catalogOffer = await fixture.client.billing_offer.create({
            data: {
              id: randomUUID(),
              tenant_id: tenant,
              offer_key: "runtime-isolated-plan",
              status: "active",
            },
          });
          const catalogRevision =
            await fixture.client.billing_offer_revision.create({
              data: {
                id: randomUUID(),
                tenant_id: tenant,
                offer_id: catalogOffer.id,
                revision: 1,
                name: "Isolated runtime plan",
                amount_minor: 9007199254740993n,
                credit_micros: 9223372036854775807n,
                currency_code: "USD",
                billing_interval: "month",
                status: "published",
                published_at: new Date("2020-01-01T00:00:00Z"),
              },
            });
          const before = await facts();
          const sessionCount = async () =>
            (
              await fixture.pool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
              )
            ).rows[0]?.count;
          const baselineSessions = await sessionCount();
          const port = await availablePort();
          const internal = randomUUID(),
            bearer = randomUUID(),
            operator = randomUUID();
          let logs = "";
          child = spawn(
            process.execPath,
            entry === "source"
              ? ["--import", "tsx", "src/main.ts"]
              : ["dist/src/main.js"],
            {
              cwd: process.cwd(),
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                ...process.env,
                DATABASE_URL: fixture.url,
                BILLING_AUTH_MODE: "jwks",
                BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
                BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
                BILLING_AUTH_JWT_AUDIENCE:
                  "https://kokoro.dev/resources/billing",
                INTERNAL_SERVICE_SECRET: internal,
                BILLING_BFF_SERVICE_TOKEN: bearer,
                BILLING_OPERATOR_PROXY_SECRET: operator,
                BILLING_PORT: String(port),
                BILLING_HOST: "127.0.0.1",
                BILLING_SHUTDOWN_DEADLINE_MS: "5000",
                // An inherited legacy dependency must not become an active dependency.
                REDIS_URL: "redis://127.0.0.1:1/0",
                BILLING_ENABLED_PROVIDERS: "",
                NODE_ENV: "test",
              },
            },
          );
          child.stdout?.on("data", (chunk) => {
            logs += String(chunk);
          });
          child.stderr?.on("data", (chunk) => {
            logs += String(chunk);
          });
          const base = `http://127.0.0.1:${port}`;
          const deadline = Date.now() + 15_000;
          while (true) {
            if (child.exitCode !== null)
              throw new Error("Billing fixture exited before readiness");
            try {
              if (
                (
                  await fetch(base + "/readyz", {
                    signal: AbortSignal.timeout(1000),
                  })
                ).status === 200
              )
                break;
            } catch {
              /* bounded boot polling */
            }
            if (Date.now() > deadline)
              throw new Error("Billing fixture readiness deadline");
            await sleep(30);
          }
          const encode = (value: string) =>
            "u1." + Buffer.from(value, "utf8").toString("base64url");
          const headers = {
            authorization: `Bearer ${bearer}`,
            "x-kokoro-internal-secret": internal,
            "x-kokoro-service": "web-bff",
            "x-kokoro-tenant-id": encode(tenant),
            "x-kokoro-subject": encode(subject),
            "x-request-id": "runtime-read-proof",
          };
          const catalogHeaders: Record<string, string> = { ...headers };
          delete catalogHeaders["x-kokoro-subject"];
          const catalog = await fetch(base + "/v2/commerce/catalog", {
            headers: catalogHeaders,
          });
          expect(catalog.status).toBe(200);
          expect(await catalog.json()).toEqual({
            data: {
              items: [
                {
                  offer_revision_id: catalogRevision.id,
                  offer_key: "runtime-isolated-plan",
                  name: "Isolated runtime plan",
                  amount_minor: "9007199254740993",
                  credit_micros: "9223372036854775807",
                  currency_code: "USD",
                  billing_interval: "month",
                },
              ],
              page: { next_cursor: null },
            },
          });
          const account = await fetch(base + "/v2/billing/me/credit-account", {
            headers,
          });
          expect(account.status).toBe(200);
          expect(await account.json()).toMatchObject({
            data: { available_micros: "9007199254740993", held_micros: "0" },
          });
          expect(account.headers.get("cache-control")).toBe("no-store");
          expect(account.headers.get("x-request-id")).toBe(
            "runtime-read-proof",
          );
          const ledger = await fetch(
            base + "/v2/billing/me/credit-ledger?limit=1",
            { headers },
          );
          expect(ledger.status).toBe(200);
          expect(await ledger.json()).toMatchObject({
            data: {
              items: [{ delta_micros: "9007199254740993" }],
              page: { next_cursor: null },
            },
          });
          const absent = await fetch(base + "/v2/billing/me/credit-account", {
            headers: { ...headers, "x-kokoro-subject": encode(randomUUID()) },
          });
          expect(absent.status).toBe(404);
          for (const key of [
            "authorization",
            "x-kokoro-internal-secret",
            "x-kokoro-service",
            "x-kokoro-tenant-id",
            "x-kokoro-subject",
          ]) {
            const wrong: Record<string, string> = { ...headers };
            delete wrong[key];
            const rejected = await fetch(
              base + "/v2/billing/me/credit-account",
              { headers: wrong },
            );
            expect([401, 403]).toContain(rejected.status);
          }
          expect(
            (await fetch(base + "/v1/billing/me/credit-account", { headers }))
              .status,
          ).toBe(404);
          expect(
            (await fetch(base + "/v2/billing/me/subscriptions", { headers }))
              .status,
          ).toBe(404);
          expect(await facts()).toEqual(before);
          // A real read blocked at the fixture table proves there is an in-flight
          // TCP request at SIGTERM. Idle shutdown alone cannot prove drain order.
          const lock = await fixture.pool.connect();
          let pending: Promise<Response> | undefined;
          let exitTimer: NodeJS.Timeout | undefined;
          try {
            await lock.query("BEGIN");
            await lock.query(
              "LOCK TABLE kokoro_billing.billing_credit_account IN ACCESS EXCLUSIVE MODE",
            );
            pending = fetch(base + "/v2/billing/me/credit-account", {
              headers,
              signal: AbortSignal.timeout(8_000),
            });
            // Attach rejection handling immediately so a failing drain does not
            // become an unhandled rejection while checking the owned PG waiter.
            const pendingResult = pending.then(
              (response) => ({ response }),
              () => ({ response: undefined }),
            );
            const waitDeadline = Date.now() + 1_000;
            while (true) {
              const waiting = await fixture.pool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%billing_credit_account%' AND pid<>pg_backend_pid()",
              );
              if (waiting.rows[0]?.count !== "0") break;
              if (Date.now() > waitDeadline)
                throw new Error("No owned pending Billing read before SIGTERM");
              await sleep(10);
            }
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await sleep(100);
            expect(child.exitCode).toBeNull();
            await lock.query("COMMIT");
            const { response: drained } = await pendingResult;
            expect(drained?.status).toBe(200);
            expect(await drained?.json()).toMatchObject({
              data: { available_micros: "9007199254740993" },
            });
            await Promise.race([
              exited,
              new Promise<never>((_resolve, reject) => {
                exitTimer = setTimeout(() => {
                  child?.kill("SIGKILL");
                  reject(new Error("Billing drain exit deadline"));
                }, 8_000);
              }),
            ]);
          } finally {
            if (exitTimer) clearTimeout(exitTimer);
            await lock.query("ROLLBACK");
            lock.release();
            if (pending) await pending.catch(() => undefined);
          }
          expect(child.exitCode).toBe(0);
          expect(await facts()).toEqual(before);
          // Child streams must be closed before asserting that no credential escaped.
          if (child.stdout && !child.stdout.readableEnded)
            await once(child.stdout, "end");
          if (child.stderr && !child.stderr.readableEnded)
            await once(child.stderr, "end");
          for (const secret of [internal, bearer, operator, fixture.url])
            expect(logs.includes(secret)).toBe(false);
          expect(await sessionCount()).toBe(baselineSessions);
        } finally {
          try {
            if (child) await stop(child);
          } finally {
            await fixture.close();
          }
        }
      },
      60_000,
    );

    it.each(["source", "dist"] as const)(
      "bounds initial PG failure without leaking credentials for %s entry",
      async (entry) => {
        // Own a rejecting TCP endpoint: no shared PostgreSQL configuration changes.
        let accepted = 0;
        const rejectingPg = createServer((socket) => {
          accepted += 1;
          socket.destroy();
        });
        const pgPort = await boundPort(rejectingPg);
        const password = randomUUID();
        const databaseUrl = `postgresql://fixture:${password}@127.0.0.1:${pgPort}/unreachable_fixture?schema=kokoro_billing`;
        const run = failureChild(entry, databaseUrl, await availablePort());
        try {
          await boundedFailure(run.child);
          expect(accepted).toBeGreaterThan(0);
          expect(run.logs()).toContain("category=startup_failed");
          for (const secret of [databaseUrl, password, ...run.secrets])
            expect(run.logs().includes(secret)).toBe(false);
        } finally {
          try {
            await stop(run.child);
          } finally {
            await closeServer(rejectingPg);
          }
        }
      },
      20_000,
    );
    it.each(["source", "dist"] as const)(
      "cleans PG sessions after listen failure and preserves owned listener for %s entry",
      async (entry) => {
        if (!admin) throw new Error("SCHEMA_ADMIN_URL required");
        const fixture = await createPrismaDatabaseFixture(admin);
        const listener = createServer((socket) =>
          socket.end("fixture-listener-alive"),
        );
        let child: ChildProcess | undefined;
        try {
          const port = await boundPort(listener);
          expect(await listenerReply(port)).toBe("fixture-listener-alive");
          const sessions = async () =>
            (
              await fixture.pool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
              )
            ).rows[0]?.count;
          const baseline = await sessions();
          const run = failureChild(entry, fixture.url, port);
          child = run.child;
          await boundedFailure(child);
          expect(run.logs()).toContain("category=startup_failed");
          const url = new URL(fixture.url);
          for (const secret of [
            fixture.url,
            ...run.secrets,
            ...(url.password
              ? [url.password, decodeURIComponent(url.password)]
              : []),
          ])
            expect(run.logs().includes(secret)).toBe(false);
          const deadline = Date.now() + 2_000;
          while ((await sessions()) !== baseline && Date.now() < deadline)
            await sleep(25);
          expect(await sessions()).toBe(baseline);
          expect(listener.listening).toBe(true);
          expect(await listenerReply(port)).toBe("fixture-listener-alive");
        } finally {
          try {
            if (child) await stop(child);
          } finally {
            try {
              if (listener.listening) await closeServer(listener);
            } finally {
              await fixture.close();
            }
          }
        }
      },
      30_000,
    );
  },
);

// Explicit opening uses the same canonical entry points and owned fixture seam.
describe.skipIf(admin === undefined)(
  "source/dist explicit zero-account HTTP",
  () => {
    it.each(["source", "dist"] as const)(
      "opens and reconciles without financial facts through %s",
      async (entry) => {
        if (!admin) throw new Error("SCHEMA_ADMIN_URL required");
        const fixture = await createPrismaDatabaseFixture(admin);
        let child: ChildProcess | undefined;
        try {
          const port = await availablePort();
          const run = failureChild(entry, fixture.url, port);
          child = run.child;
          const base = `http://127.0.0.1:${port}`;
          const deadline = performance.now() + 20000;
          while (true) {
            if (child.exitCode !== null)
              throw new Error("Owner exited before readiness");
            try {
              if (
                (
                  await fetch(base + "/readyz", {
                    signal: AbortSignal.timeout(500),
                  })
                ).status === 200
              )
                break;
            } catch {
              /* finite readiness only */
            }
            if (performance.now() >= deadline)
              throw new Error("Owner readiness deadline");
            await sleep(30);
          }
          const tenant = randomUUID(),
            subject = randomUUID();
          const headers = {
            authorization: `Bearer ${run.secrets[1]}`,
            "x-kokoro-internal-secret": run.secrets[0] ?? "",
            "x-kokoro-service": "web-bff",
            "x-kokoro-tenant-id":
              "u1." + Buffer.from(tenant).toString("base64url"),
            "x-kokoro-subject":
              "u1." + Buffer.from(subject).toString("base64url"),
            "content-type": "application/json",
          };
          const url = base + "/v2/billing/me/credit-account";
          const missing = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(5000),
          });
          expect(missing.status).toBe(404);
          await missing.text();
          // Drop the real HTTP response body after headers: the application has
          // no account ACK to apply, although the owner may already have committed.
          const status = await new Promise<number | undefined>(
            (resolve, reject) => {
              const request = httpRequest(
                url,
                { method: "PUT", headers },
                (response) => {
                  const status = response.statusCode;
                  response.destroy();
                  resolve(status);
                },
              );
              request.once("error", reject);
              request.setTimeout(5000, () =>
                request.destroy(new Error("Owned response deadline")),
              );
              request.end("{}");
            },
          );
          expect(status).toBe(200);
          const reconciled = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(5000),
          });
          expect(reconciled.status).toBe(200);
          const result: unknown = await reconciled.json();
          expect(result).toMatchObject({
            data: { available_micros: "0", held_micros: "0" },
          });
          const replay = await fetch(url, {
            method: "PUT",
            headers,
            body: "{}",
            signal: AbortSignal.timeout(5000),
          });
          expect(replay.status).toBe(200);
          expect(await replay.json()).toEqual(result);
          const ledger = await fetch(base + "/v2/billing/me/credit-ledger", {
            headers,
            signal: AbortSignal.timeout(5000),
          });
          expect(ledger.status).toBe(200);
          expect(await ledger.json()).toMatchObject({ data: { items: [] } });
          const counts = await fixture.pool.query<{
            name: string;
            count: string;
          }>(
            "SELECT tablename AS name, '0' AS count FROM pg_tables WHERE schemaname='kokoro_billing' ORDER BY tablename",
          );
          expect(counts.rows).toHaveLength(35);
          for (const { name } of counts.rows) {
            if (!/^[a-z][a-z0-9_]*$/u.test(name))
              throw new Error("Invalid owner table");
            const row = await fixture.pool.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM kokoro_billing."${name}"`,
            );
            expect(row.rows[0]?.count, name).toBe(
              ["billing_credit_account", "billing_audit_event"].includes(name)
                ? "1"
                : "0",
            );
          }
        } finally {
          try {
            if (child) await stop(child);
          } finally {
            await fixture.close();
          }
        }
      },
      30000,
    );
  },
);
