import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  createBillingConnection,
  runWithBillingContext,
} from "../../src/infrastructure/postgres/connection.js";
import type {
  SqlConnection,
  RowDataPacket,
} from "../../src/infrastructure/postgres/database.js";
import {
  createPostgresUsagePricingAdminService,
  createPostgresUsagePricingService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

// Observe real statements/results; never replace the PostgreSQL MAX or transaction.
function observePricingMax(
  connection: SqlConnection,
  afterMax: () => Promise<void>,
): SqlConnection {
  return {
    query: connection.query.bind(connection),
    execute: async <T = RowDataPacket[]>(
      sql: string,
      values?: unknown[],
    ): Promise<[T, unknown[]]> => {
      const result = await connection.execute<T>(sql, values);
      if (sql.includes("COALESCE(MAX(revision), 0)")) await afterMax();
      return result;
    },
    beginTransaction: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    withTransaction: connection.withTransaction.bind(connection),
    ping: connection.ping.bind(connection),
    end: connection.end.bind(connection),
  };
}

const pricingInput = (tenantId = randomUUID()) => ({
  tenantId,
  operatorId: "s2-operator",
  effectiveFrom: new Date(),
  reason: "S2 isolated concurrency fixture",
  idempotencyKey: randomUUID(),
  rates: [
    {
      featureKey: "chat",
      inputMicrosPerMillion: 2,
      outputMicrosPerMillion: 4,
      reservationMicros: 10,
    },
    {
      featureKey: "search",
      inputMicrosPerMillion: 3,
      outputMicrosPerMillion: 6,
      reservationMicros: 20,
    },
  ],
});

const pricingLock =
  "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kokoro-billing:usage-pricing:' || $1, 0))";
const tryPricingLock =
  "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('kokoro-billing:usage-pricing:' || $1, 0)) AS acquired";

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("S2 barrier deadline exceeded");
    await delay(5);
  }
}

async function pricingCounts(connection: SqlConnection, tenantId: string) {
  const [rows] = await connection.query<
    { revisions: number; rates: number; receipts: number; audits: number }[]
  >(
    `SELECT
      (SELECT count(*)::int FROM entitlement_usage_price_revision WHERE tenant_id = $1) AS revisions,
      (SELECT count(*)::int FROM entitlement_usage_price_rate WHERE tenant_id = $1) AS rates,
      (SELECT count(*)::int FROM entitlement_command_receipt WHERE tenant_id = $1 AND command_name = 'usage.pricing.publish') AS receipts,
      (SELECT count(*)::int FROM entitlement_audit_event WHERE tenant_id = $1 AND action = 'usage.pricing.publish') AS audits`,
    [tenantId],
  );
  return assertDefined(rows[0]);
}

async function timeouts(connection: SqlConnection) {
  const [rows] = await connection.query<
    { lock_timeout: string; statement_timeout: string }[]
  >(
    "SELECT pg_catalog.current_setting('lock_timeout') AS lock_timeout, pg_catalog.current_setting('statement_timeout') AS statement_timeout",
  );
  return assertDefined(rows[0]);
}

integration("admin usage pricing revisions", () => {
  it("publishes an immutable revision, is idempotent, and serves quotes", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const admin = createPostgresUsagePricingAdminService(connection);
    const pricing = createPostgresUsagePricingService(connection);
    const tenantId = randomUUID();
    const idempotencyKey = `pricing-publish-${randomUUID()}`;
    const input = {
      tenantId,
      operatorId: "operator-1",
      effectiveFrom: new Date(),
      reason: "initial target pricing",
      idempotencyKey,
      rates: [
        {
          featureKey: "chat",
          labelKey: "model-a",
          inputMicrosPerMillion: 2,
          outputMicrosPerMillion: 4,
          reservationMicros: 10,
        },
      ],
    } as const;
    try {
      const first = await admin.publish(input);
      const replay = await admin.publish(input);
      expect(replay).toEqual(first);
      const quote = await pricing.quote({
        tenantId,
        featureKey: "chat",
        labelKey: "model-a",
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      expect(quote.pricingRevisionId).toBe(first.pricingRevisionId);
      expect(quote.amountMicros).toBe(2);
      expect(quote.reservationMicros).toBe(10);
      await expect(
        admin.publish({
          ...input,
          rates: [{ ...input.rates[0], outputMicrosPerMillion: 5 }],
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
    } finally {
      await connection.end();
    }
  });

  it("serializes two real MAX readers for one tenant and replays both complete publications", async () => {
    const a = await createBillingConnection(assertDefined(databaseUrl));
    const b = await createBillingConnection(assertDefined(databaseUrl));
    const observer = await createBillingConnection(assertDefined(databaseUrl));
    const releases: (() => void)[] = [];
    const pauseA = new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    const releaseA = assertDefined(releases[0]);
    let aAtMax = false;
    let bAtMax = false;
    let bPid: number | undefined;
    const inputA = pricingInput();
    const inputB = { ...inputA, idempotencyKey: randomUUID() };
    const observedA = observePricingMax(a, async () => {
      aAtMax = true;
      await pauseA;
    });
    const observedB = observePricingMax(b, () => {
      bAtMax = true;
      return Promise.resolve();
    });
    const pending: Promise<unknown>[] = [];
    const outcomes: Promise<PromiseSettledResult<unknown>[]>[] = [];
    try {
      const first = runWithBillingContext(() =>
        a.withTransaction(async () => {
          await a.query(
            "SELECT pg_catalog.set_config('statement_timeout', '3s', true)",
          );
          return createPostgresUsagePricingAdminService(observedA).publish(
            inputA,
          );
        }),
      );
      pending.push(first);
      outcomes.push(Promise.allSettled([first]));
      await waitUntil(() => Promise.resolve(aAtMax));
      const second = runWithBillingContext(() =>
        b.withTransaction(async () => {
          const [rows] = await b.query<{ pid: number }[]>(
            "SELECT pg_catalog.pg_backend_pid() AS pid",
          );
          bPid = assertDefined(rows[0]).pid;
          await b.query(
            "SELECT pg_catalog.set_config('statement_timeout', '3s', true)",
          );
          return createPostgresUsagePricingAdminService(observedB).publish(
            inputB,
          );
        }),
      );
      pending.push(second);
      outcomes.push(Promise.allSettled([second]));
      // Old code reaches MAX; repaired code must wait before its independent MAX.
      await waitUntil(async () => {
        if (bAtMax) return true;
        if (bPid === undefined) return false;
        const [rows] = await observer.query<{ waiting: boolean }[]>(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted) AS waiting",
          [bPid],
        );
        return assertDefined(rows[0]).waiting;
      }, 750);
      releaseA();
      const settled = (await Promise.all(outcomes)).flat();
      // Keep the real pg error (including 23505) visible in the RED evidence.
      expect(settled.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
      const [resultA, resultB] = await Promise.all([first, second]);
      expect([resultA.revision, resultB.revision]).toEqual([1, 2]);
      expect(resultA.pricingRevisionId).not.toBe(resultB.pricingRevisionId);
      const [rates] = await observer.query<
        {
          usage_price_revision_id: string;
          feature_key: string;
          input_micros_per_million: string;
          output_micros_per_million: string;
          reservation_micros: string;
        }[]
      >(
        "SELECT usage_price_revision_id, feature_key, input_micros_per_million, output_micros_per_million, reservation_micros FROM entitlement_usage_price_rate WHERE tenant_id = $1 ORDER BY feature_key",
        [inputA.tenantId],
      );
      for (const result of [resultA, resultB]) {
        expect(
          rates.filter(
            (row) => row.usage_price_revision_id === result.pricingRevisionId,
          ),
        ).toEqual([
          {
            usage_price_revision_id: result.pricingRevisionId,
            feature_key: "chat",
            input_micros_per_million: "2",
            output_micros_per_million: "4",
            reservation_micros: "10",
          },
          {
            usage_price_revision_id: result.pricingRevisionId,
            feature_key: "search",
            input_micros_per_million: "3",
            output_micros_per_million: "6",
            reservation_micros: "20",
          },
        ]);
      }
      const [receipts] = await observer.query<
        { idempotency_key: string; status: string; result_json: unknown }[]
      >(
        "SELECT idempotency_key, status, result_json FROM entitlement_command_receipt WHERE tenant_id = $1",
        [inputA.tenantId],
      );
      for (const [input, result] of [
        [inputA, resultA],
        [inputB, resultB],
      ] as const) {
        expect(
          receipts.find((row) => row.idempotency_key === input.idempotencyKey),
        ).toEqual({
          idempotency_key: input.idempotencyKey,
          status: "succeeded",
          result_json: result,
        });
        expect(
          await runWithBillingContext(() =>
            createPostgresUsagePricingAdminService(a).publish(input),
          ),
        ).toEqual(result);
      }
      const [audits] = await observer.query<
        { resource_id: string; payload_json: unknown }[]
      >(
        "SELECT resource_id, payload_json FROM entitlement_audit_event WHERE tenant_id = $1 AND action = 'usage.pricing.publish'",
        [inputA.tenantId],
      );
      expect(audits).toEqual(
        expect.arrayContaining(
          [resultA, resultB].map((result) => ({
            resource_id: result.pricingRevisionId,
            payload_json: { revision: result.revision, rateCount: 2 },
          })),
        ),
      );
      expect(await pricingCounts(observer, inputA.tenantId)).toEqual({
        revisions: 2,
        rates: 4,
        receipts: 2,
        audits: 2,
      });
    } finally {
      releaseA();
      await Promise.allSettled(pending);
      await Promise.all([a.end(), b.end(), observer.end()]);
    }
  });

  it("restores nested budgets immediately, retains the lock until outer commit, and permits another tenant", async () => {
    const a = await createBillingConnection(assertDefined(databaseUrl));
    const b = await createBillingConnection(assertDefined(databaseUrl));
    const input = pricingInput();
    try {
      await runWithBillingContext(async () => {
        await a.beginTransaction();
        try {
          await a.query(
            "SELECT pg_catalog.set_config('lock_timeout', '2s', true), pg_catalog.set_config('statement_timeout', '3s', true)",
          );
          const original = await timeouts(a);
          const observed = observePricingMax(a, async () => {
            expect(await timeouts(a)).toEqual(original);
          });
          await createPostgresUsagePricingAdminService(observed).publish(input);
          expect(await timeouts(a)).toEqual(original);
          const [held] = await b.query<{ acquired: boolean }[]>(
            tryPricingLock,
            [input.tenantId],
          );
          expect(assertDefined(held[0]).acquired).toBe(false);
          expect(await pricingCounts(b, input.tenantId)).toEqual({
            revisions: 0,
            rates: 0,
            receipts: 0,
            audits: 0,
          });
          const other = pricingInput();
          const result = await runWithBillingContext(() =>
            createPostgresUsagePricingAdminService(b).publish(other),
          );
          expect(result.revision).toBe(1);
          expect(await pricingCounts(b, other.tenantId)).toEqual({
            revisions: 1,
            rates: 2,
            receipts: 1,
            audits: 1,
          });
          await a.commit();
        } finally {
          await a.rollback();
        }
      });
      const [released] = await b.query<{ acquired: boolean }[]>(
        tryPricingLock,
        [input.tenantId],
      );
      expect(assertDefined(released[0]).acquired).toBe(true);
      expect(await pricingCounts(b, input.tenantId)).toEqual({
        revisions: 1,
        rates: 2,
        receipts: 1,
        audits: 1,
      });
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it("replays a succeeded receipt without waiting on another pricing publication", async () => {
    const blocker = await createBillingConnection(assertDefined(databaseUrl));
    const publisher = await createBillingConnection(assertDefined(databaseUrl));
    const input = pricingInput();
    try {
      const result = await runWithBillingContext(() =>
        createPostgresUsagePricingAdminService(publisher).publish(input),
      );
      await runWithBillingContext(async () => {
        await blocker.beginTransaction();
        try {
          await blocker.query(pricingLock, [input.tenantId]);
          await runWithBillingContext(() =>
            publisher.withTransaction(async () => {
              await publisher.query(
                "SELECT pg_catalog.set_config('statement_timeout', '100ms', true)",
              );
              expect(
                await createPostgresUsagePricingAdminService(publisher).publish(
                  input,
                ),
              ).toEqual(result);
            }),
          );
          expect(await pricingCounts(publisher, input.tenantId)).toEqual({
            revisions: 1,
            rates: 2,
            receipts: 1,
            audits: 1,
          });
        } finally {
          await blocker.rollback();
        }
      });
    } finally {
      await Promise.all([blocker.end(), publisher.end()]);
    }
  });

  it.each([
    { lock: "0", statement: "0", code: "55P03", maximum: 1600 },
    { lock: "2s", statement: "0", code: "55P03", maximum: 1600 },
    { lock: "40ms", statement: "0", code: "55P03", maximum: 700 },
    { lock: "2s", statement: "30ms", code: "57014", maximum: 700 },
  ])(
    "bounds lock=$lock / statement=$statement and rolls back nested failure without half writes",
    async ({ lock, statement, code, maximum }) => {
      const blocker = await createBillingConnection(assertDefined(databaseUrl));
      const publisher = await createBillingConnection(
        assertDefined(databaseUrl),
      );
      const input = pricingInput();
      try {
        await runWithBillingContext(async () => {
          await blocker.beginTransaction();
          const deadline = new AbortController();
          let operation: Promise<void> | undefined;
          try {
            await blocker.query(pricingLock, [input.tenantId]);
            operation = runWithBillingContext(async () => {
              await publisher.beginTransaction();
              try {
                await publisher.query(
                  "SELECT pg_catalog.set_config('lock_timeout', $1, true), pg_catalog.set_config('statement_timeout', $2, true)",
                  [lock, statement],
                );
                const original = await timeouts(publisher);
                const start = performance.now();
                await expect(
                  createPostgresUsagePricingAdminService(publisher).publish(
                    input,
                  ),
                ).rejects.toMatchObject({ code });
                expect(performance.now() - start).toBeLessThan(maximum);
                expect(await timeouts(publisher)).toEqual(original);
                const [usable] =
                  await publisher.query<{ value: number }[]>(
                    "SELECT 1 AS value",
                  );
                expect(usable).toEqual([{ value: 1 }]);
                expect(await pricingCounts(publisher, input.tenantId)).toEqual({
                  revisions: 0,
                  rates: 0,
                  receipts: 0,
                  audits: 0,
                });
              } finally {
                await publisher.rollback();
              }
            });
            // A broken unlimited budget must fail, not leave the test holding its lock forever.
            await Promise.race([
              operation,
              delay(2500, undefined, { signal: deadline.signal }),
            ]);
            expect(await pricingCounts(publisher, input.tenantId)).toEqual({
              revisions: 0,
              rates: 0,
              receipts: 0,
              audits: 0,
            });
          } finally {
            deadline.abort();
            try {
              await blocker.rollback();
            } finally {
              // If the safety deadline won, releasing our lock lets the actual SQL settle.
              if (operation) await operation;
            }
          }
        });
      } finally {
        await Promise.all([blocker.end(), publisher.end()]);
      }
    },
  );

  it("preserves REPEATABLE READ conflict and nested rollback rather than changing outer isolation", async () => {
    const stale = await createBillingConnection(assertDefined(databaseUrl));
    const current = await createBillingConnection(assertDefined(databaseUrl));
    const input = pricingInput();
    try {
      await runWithBillingContext(async () => {
        await stale.beginTransaction();
        try {
          await stale.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          await stale.query(
            "SELECT pg_catalog.set_config('statement_timeout', '3s', true)",
          );
          await stale.query(
            "SELECT revision FROM entitlement_usage_price_revision WHERE tenant_id = $1",
            [input.tenantId],
          );
          await runWithBillingContext(() =>
            createPostgresUsagePricingAdminService(current).publish(input),
          );
          await expect(
            createPostgresUsagePricingAdminService(stale).publish({
              ...input,
              idempotencyKey: randomUUID(),
            }),
          ).rejects.toMatchObject({ code: "23505" });
          const [settings] = await stale.query<{ isolation: string }[]>(
            "SELECT pg_catalog.current_setting('transaction_isolation') AS isolation",
          );
          expect(settings).toEqual([{ isolation: "repeatable read" }]);
        } finally {
          await stale.rollback();
        }
      });
      expect(await pricingCounts(current, input.tenantId)).toEqual({
        revisions: 1,
        rates: 2,
        receipts: 1,
        audits: 1,
      });
    } finally {
      await Promise.all([stale.end(), current.end()]);
    }
  });
});
