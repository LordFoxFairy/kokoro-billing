import { randomUUID } from "node:crypto";
/* eslint-disable @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/require-await */
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TransactionContextError } from "../../src/database/transaction.error.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import {
  maximumTransactionTimeoutMs,
  type TransactionScope,
} from "../../src/database/transaction.types.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
const describeDatabase = adminUrl === undefined ? describe.skip : describe;
const writeScope = (tenantId = "tenant-a"): TransactionScope => ({
  tenantId,
  actorId: "actor-a",
  operation: "test",
  mode: "write",
});
const accountData = (id: string, tenantId = "tenant-a") => ({
  id,
  tenant_id: tenantId,
  subject_id: id,
});
const accountCount = async (fixture: PrismaDatabaseFixture, id: string) =>
  fixture.client.billing_credit_account.count({
    where: { id },
  });

describeDatabase("TransactionService with PostgreSQL", () => {
  let fixture!: PrismaDatabaseFixture;
  let service: TransactionService;

  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(adminUrl ?? "");
    service = new TransactionService(fixture.client);
  });
  afterEach(async () => fixture?.close());

  it("uses one backend and txid and hides writes until commit", async () => {
    const outside = new Pool({
      connectionString: fixture.url,
      options: "-c search_path=public,pg_catalog",
    });
    try {
      const marker = randomUUID();
      await service.run(writeScope(), async () => {
        const tx = service.requireActiveTransaction("tenant-a", "write");
        const first = await tx.$queryRawUnsafe<
          Array<{ pid: number; txid: bigint }>
        >("SELECT pg_backend_pid() pid, txid_current() txid");
        await tx.billing_credit_account.create({
          data: accountData(marker),
        });
        await service.run(writeScope(), async () => {
          const nested = service.requireActiveTransaction("tenant-a", "write");
          expect(nested).toBe(tx);
          const second = await nested.$queryRawUnsafe<
            Array<{ pid: number; txid: bigint }>
          >("SELECT pg_backend_pid() pid, txid_current() txid");
          expect(second[0]).toEqual(first[0]);
        });
        const hidden = await outside.query<{ count: number }>(
          "SELECT count(*)::int count FROM billing_credit_account WHERE id=$1",
          [marker],
        );
        expect(hidden.rows[0]?.count).toBe(0);
      });
      const visible = await outside.query<{ count: number }>(
        "SELECT count(*)::int count FROM billing_credit_account WHERE id=$1",
        [marker],
      );
      expect(visible.rows[0]?.count).toBe(1);
    } finally {
      await outside.end();
    }
  });

  it.each([undefined, null, false, 0])(
    "rolls back when a nested falsey cause %s is swallowed",
    async (cause) => {
      const id = randomUUID();
      await expect(
        service.run(writeScope(), async () => {
          const tx = service.requireActiveTransaction("tenant-a", "write");
          await tx.billing_credit_account.create({ data: accountData(id) });
          try {
            await service.run(writeScope(), async () => Promise.reject(cause));
          } catch {
            // The outer boundary must still observe the recorded falsey cause.
          }
        }),
      ).rejects.toBe(cause);
      expect(await accountCount(fixture, id)).toBe(0);
    },
  );

  it("retains the first nested failure and never calls mismatched callbacks", async () => {
    const first = new Error("first");
    let calls = 0;
    await expect(
      service.run(writeScope(), async () => {
        try {
          await service.run(writeScope(), async () => Promise.reject(first));
        } catch {
          // Exercise rollback-only even when business code handles the error.
        }
        try {
          await service.run(
            { ...writeScope("other"), actorId: "other" },
            async () => {
              calls += 1;
            },
          );
        } catch {
          // The first cause must remain authoritative.
        }
      }),
    ).rejects.toBe(first);
    expect(calls).toBe(0);
  });

  it("turns a swallowed SQL error into rollback and leaves the pool reusable", async () => {
    const id = randomUUID();
    let sqlError: unknown;
    let rejected: unknown;
    try {
      await service.run(writeScope(), async () => {
        const tx = service.requireActiveTransaction("tenant-a", "write");
        await tx.billing_credit_account.create({ data: accountData(id) });
        try {
          await tx.$queryRawUnsafe(
            "SELECT missing_column FROM billing_audit_event",
          );
        } catch (error) {
          sqlError = error;
        }
      });
    } catch (error) {
      rejected = error;
    }
    expect(
      sqlError !== undefined &&
        rejected !== undefined &&
        (rejected === sqlError ||
          (rejected instanceof AggregateError && rejected.cause === sqlError)),
    ).toBe(true);
    expect(sqlError).toMatchObject({ code: "P2010" });
    expect(await accountCount(fixture, id)).toBe(0);
    await expect(
      fixture.client.$queryRawUnsafe("SELECT 1"),
    ).resolves.toBeDefined();
  });

  it("isolates concurrent scopes", async () => {
    await Promise.all([
      service.run(writeScope("a"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        service.requireActiveTransaction("a", "write");
      }),
      service.run({ ...writeScope("b"), actorId: "actor-b" }, async () => {
        service.requireActiveTransaction("b", "write");
      }),
    ]);
  });

  it("copies and freezes the root identity against caller mutation", async () => {
    const scope = { ...writeScope() };
    await service.run(scope, async () => {
      scope.tenantId = "mutated";
      expect(
        service.requireActiveTransaction("tenant-a", "write"),
      ).toBeDefined();
      await service.run(writeScope(), async () => {
        expect(
          service.requireActiveTransaction("tenant-a", "write"),
        ).toBeDefined();
      });
    });
  });

  it("rejects a transaction client used from another active scope before SQL", async () => {
    let clientA!: ReturnType<TransactionService["requireActiveTransaction"]>;
    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let readyA!: () => void;
    const ready = new Promise<void>((resolve) => {
      readyA = resolve;
    });
    const runA = service.run(writeScope("a"), async () => {
      clientA = service.requireActiveTransaction("a", "write");
      readyA();
      await holdA;
    });
    let assertionError: unknown;
    let cleanupError: unknown;
    try {
      await Promise.race([ready, runA]);
      await expect(
        service.run({ ...writeScope("b"), actorId: "actor-b" }, async () => {
          await expect(
            clientA.$queryRawUnsafe("SELECT 1"),
          ).rejects.toMatchObject({ code: "TRANSACTION_CONTEXT_MISMATCH" });
        }),
      ).rejects.toMatchObject({ code: "TRANSACTION_CONTEXT_MISMATCH" });
    } catch (error) {
      assertionError = error;
    } finally {
      releaseA();
      try {
        await runA;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (assertionError instanceof Error) throw assertionError;
    if (assertionError !== undefined)
      throw new Error("Foreign-scope assertion failed", {
        cause: assertionError,
      });
    if (cleanupError instanceof Error) throw cleanupError;
    if (cleanupError !== undefined)
      throw new Error("Owner transaction cleanup failed", {
        cause: cleanupError,
      });
  });

  it("rejects inherited closed contexts before delayed SQL", async () => {
    let delayed!: Promise<unknown>;
    let captured!: ReturnType<TransactionService["requireActiveTransaction"]>;
    let lazy!: ReturnType<typeof captured.$queryRawUnsafe>;
    await service.run(writeScope(), async () => {
      captured = service.requireActiveTransaction("tenant-a", "write");
      lazy = captured.$queryRawUnsafe("SELECT 1");
      delayed = new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            void captured.$queryRawUnsafe("SELECT 1").then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        }, 30);
      });
    });
    await expect(delayed).rejects.toMatchObject({
      code: "TRANSACTION_CONTEXT_CLOSED",
    });
    await expect(lazy).rejects.toMatchObject({
      code: "TRANSACTION_CONTEXT_MISMATCH",
    });
  });

  it("provides a repeatable read-only snapshot", async () => {
    const outside = new Pool({
      connectionString: fixture.url,
      options: "-c search_path=public,pg_catalog",
    });
    const count = async () =>
      service
        .requireActiveTransaction("tenant-a", "readOnlySnapshot")
        .$queryRawUnsafe<Array<{ count: number }>>(
          "SELECT count(*)::int count FROM billing_audit_event",
        );
    const marker = randomUUID();
    try {
      let readOnlyError: unknown;
      try {
        await service.run(
          { ...writeScope(), mode: "readOnlySnapshot" },
          async () => {
            const before = await count();
            await outside.query(
              "INSERT INTO billing_audit_event (id, tenant_id, operator_id, action, resource_type, resource_id, reason, payload_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,'test','{}',now())",
              [randomUUID(), "tenant-a", "actor-a", "test", "probe", marker],
            );
            expect(await count()).toEqual(before);
            await service
              .requireActiveTransaction("tenant-a", "readOnlySnapshot")
              .$executeRawUnsafe("DELETE FROM billing_audit_event");
          },
        );
      } catch (error) {
        readOnlyError = error;
      }
      expect(readOnlyError).toMatchObject({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "25006" } } },
      });
      const persisted = await outside.query<{ count: number }>(
        "SELECT count(*)::int count FROM billing_audit_event WHERE resource_id=$1",
        [marker],
      );
      expect(persisted.rows[0]?.count).toBe(1);
    } finally {
      await outside.end();
    }
  });

  it("enforces statement and transaction budgets without committing", async () => {
    const statementWriteId = randomUUID();
    const budgeted = new TransactionService(fixture.client, {
      timeoutMs: 200,
      statementTimeoutMs: 100,
      lockTimeoutMs: 50,
      idleInTransactionTimeoutMs: 200,
    });
    await expect(
      budgeted.run(writeScope(), async () => {
        const tx = budgeted.requireActiveTransaction("tenant-a", "write");
        await tx.billing_credit_account.create({
          data: accountData(statementWriteId),
        });
        await tx.$queryRawUnsafe("SELECT pg_sleep(0.5)");
      }),
    ).rejects.toMatchObject({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "57014" } } },
    });
    expect(await accountCount(fixture, statementWriteId)).toBe(0);
    await expect(
      fixture.client.$queryRawUnsafe("SELECT 1"),
    ).resolves.toBeDefined();

    const transactionBudget = new TransactionService(fixture.client, {
      timeoutMs: 100,
      statementTimeoutMs: 80,
      lockTimeoutMs: 40,
      idleInTransactionTimeoutMs: 100,
    });
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    let resolveClosed!: (value: unknown) => void;
    let rejectClosed!: (reason: unknown) => void;
    const closedCheck = new Promise<unknown>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    const timedRun = transactionBudget.run(writeScope(), async () => {
      const captured = transactionBudget.requireActiveTransaction(
        "tenant-a",
        "write",
      );
      await callbackGate;
      try {
        transactionBudget.requireActiveTransaction("tenant-a", "write");
        resolveClosed(await captured.$queryRawUnsafe("SELECT 1"));
      } catch (error) {
        rejectClosed(error);
      }
    });
    const timedResult = expect(timedRun).rejects.toMatchObject({
      code: "P2028",
    });
    setTimeout(releaseCallback, 250);
    await expect(closedCheck).rejects.toMatchObject({
      code: "TRANSACTION_CONTEXT_CLOSED",
    });
    await timedResult;
  });

  it("enforces the lock budget and validates all configured budgets", async () => {
    const id = randomUUID();
    const priorWriteId = randomUUID();
    await fixture.client.$executeRawUnsafe(
      "INSERT INTO billing_audit_event (id, tenant_id, operator_id, action, resource_type, resource_id, reason, payload_json, created_at) VALUES ($1,'tenant-a','actor-a','test','probe',$1,'test','{}',now())",
      id,
    );
    const locker = await fixture.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        "UPDATE billing_audit_event SET reason='locked' WHERE id=$1",
        [id],
      );
      const budgeted = new TransactionService(fixture.client, {
        timeoutMs: 300,
        statementTimeoutMs: 200,
        lockTimeoutMs: 50,
        idleInTransactionTimeoutMs: 300,
      });
      await expect(
        budgeted.run(writeScope(), async () => {
          await budgeted
            .requireActiveTransaction("tenant-a", "write")
            .billing_credit_account.create({
              data: accountData(priorWriteId),
            });
          await budgeted
            .requireActiveTransaction("tenant-a", "write")
            .$executeRawUnsafe(
              "UPDATE billing_audit_event SET reason='waiter' WHERE id=$1",
              id,
            );
        }),
      ).rejects.toMatchObject({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect(await accountCount(fixture, priorWriteId)).toBe(0);
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { maxWaitMs: maximumTransactionTimeoutMs + 1 },
      { timeoutMs: 100, statementTimeoutMs: 100 },
      { statementTimeoutMs: 100, lockTimeoutMs: 100 },
      { timeoutMs: 100, idleInTransactionTimeoutMs: 99 },
    ])
      expect(() => new TransactionService(fixture.client, options)).toThrow(
        RangeError,
      );
  });

  it.each([
    [{ ...writeScope(), tenantId: "other" }, "TRANSACTION_CONTEXT_MISMATCH"],
    [{ ...writeScope(), actorId: "other" }, "TRANSACTION_CONTEXT_MISMATCH"],
    [
      { ...writeScope(), mode: "readOnlySnapshot" as const },
      "TRANSACTION_MODE_MISMATCH",
    ],
  ] as const)(
    "rejects an isolated nested mismatch %# before its callback",
    async (nestedScope, code) => {
      const id = randomUUID();
      let calls = 0;
      await expect(
        service.run(writeScope(), async () => {
          const tx = service.requireActiveTransaction("tenant-a", "write");
          await tx.billing_credit_account.create({ data: accountData(id) });
          await service.run(nestedScope, async () => {
            calls += 1;
          });
        }),
      ).rejects.toMatchObject({ code });
      expect(calls).toBe(0);
      expect(await accountCount(fixture, id)).toBe(0);
    },
  );

  it("rejects a root operation while a transaction is active", async () => {
    await service.run(writeScope(), async () => {
      expect(() => service.assertNoActiveTransaction()).toThrow(
        TransactionContextError,
      );
    });
  });
});
