import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { Prisma } from "../../src/generated/prisma/client.js";
import { readSafeInteger } from "../../src/application/ports/safe-integer.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const anyObject: unknown = expect.any(Object);

const adminUrl = process.env.SCHEMA_ADMIN_URL;
const integration = describe.skipIf(!adminUrl);
const id = () => randomUUID();
const hash = "a".repeat(64);

integration("Prisma PostgreSQL persistence", () => {
  let fixture!: PrismaDatabaseFixture;
  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
  });
  afterEach(async () => fixture?.close());

  it("rejects fixture initialization failures without hanging", async () => {
    await expect(
      createPrismaDatabaseFixture(
        "postgresql://fixture@127.0.0.1:1/postgres?schema=private",
      ),
    ).rejects.toThrow(/schema parameters/iu);
  });

  it("performs typed CRUD with UTC millisecond and exact BigInt/JSON null semantics", async () => {
    const accountId = id();
    const instant = new Date("2026-09-08T12:34:56.789Z");
    await fixture.client.entitlement_credit_account.create({
      data: {
        credit_account_id: accountId,
        tenant_id: "tenant",
        subject_id: "subject",
        available_micros: 9_007_199_254_740_993n,
        created_at: instant,
        updated_at: instant,
      },
    });
    const row = await fixture.client.$transaction(async (tx) => {
      const before = await tx.$queryRaw<Array<{ pid: number; txid: bigint }>>`
        SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.txid_current() AS txid
      `;
      const updated = await tx.entitlement_credit_account.update({
        where: { credit_account_id: accountId },
        data: { generation: { increment: 1n } },
      });
      const after = await tx.$queryRaw<Array<{ pid: number; txid: bigint }>>`
        SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.txid_current() AS txid
      `;
      expect(after).toEqual(before);
      return updated;
    });
    expect(row.available_micros).toBe(9_007_199_254_740_993n);
    expect(row.created_at.toISOString()).toBe(instant.toISOString());
    expect(() =>
      readSafeInteger(row.available_micros, "available_micros"),
    ).toThrow("billing.available_micros_precision");

    const base = {
      tenant_id: "tenant",
      command_name: "json-test",
      payload_hash: hash,
      status: "succeeded",
    };
    await fixture.client.entitlement_command_receipt.createMany({
      data: [
        {
          ...base,
          receipt_id: id(),
          idempotency_key: id(),
          result_json: Prisma.DbNull,
        },
        {
          ...base,
          receipt_id: id(),
          idempotency_key: id(),
          result_json: Prisma.JsonNull,
        },
      ],
    });
    expect(
      await fixture.client.entitlement_command_receipt.count({
        where: { result_json: { equals: Prisma.DbNull } },
      }),
    ).toBe(1);
    expect(
      await fixture.client.entitlement_command_receipt.count({
        where: { result_json: { equals: Prisma.JsonNull } },
      }),
    ).toBe(1);
    await fixture.client.entitlement_credit_account.delete({
      where: { credit_account_id: accountId },
    });
    expect(await fixture.client.entitlement_credit_account.count()).toBe(0);
  });

  it("commits receipt/account/journal/outbox atomically and rolls all back on failure", async () => {
    const writeGroup = async (suffix: string, fail: boolean) =>
      fixture.client.$transaction(
        async (tx) => {
          const account = id();
          const receipt = await tx.entitlement_command_receipt.create({
            data: {
              receipt_id: id(),
              tenant_id: "tenant",
              command_name: "grant",
              idempotency_key: suffix,
              payload_hash: hash,
            },
          });
          await tx.entitlement_credit_account.create({
            data: {
              credit_account_id: account,
              tenant_id: "tenant",
              subject_id: suffix,
              available_micros: 1n,
            },
          });
          await tx.entitlement_credit_journal.create({
            data: {
              journal_id: id(),
              tenant_id: "tenant",
              credit_account_id: account,
              journal_seq: 1n,
              entry_kind: "grant",
              amount_micros: 1n,
              source_kind: "test",
              source_ref: suffix,
            },
          });
          await tx.entitlement_outbox.create({
            data: {
              outbox_id: id(),
              tenant_id: "tenant",
              aggregate_type: "credit",
              aggregate_id: account,
              event_type: "granted",
              payload_json: { suffix, account, result: "credited" },
            },
          });
          await tx.entitlement_command_receipt.update({
            where: { receipt_id: receipt.receipt_id },
            data: {
              status: "succeeded",
              result_json: { account, result: "credited" },
            },
          });
          expect(
            await fixture.client.entitlement_credit_account.count({
              where: { credit_account_id: account },
            }),
          ).toBe(0);
          if (fail) throw new Error("rollback marker");
          return account;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 2_000,
        },
      );
    const committedAccount = await writeGroup("committed", false);
    await expect(writeGroup("rolled-back", true)).rejects.toThrow(
      "rollback marker",
    );
    expect(
      await Promise.all([
        fixture.client.entitlement_command_receipt.count(),
        fixture.client.entitlement_credit_account.count(),
        fixture.client.entitlement_credit_journal.count(),
        fixture.client.entitlement_outbox.count(),
      ]),
    ).toEqual([1, 1, 1, 1]);
    expect(
      await fixture.client.entitlement_credit_account.findUniqueOrThrow({
        where: { credit_account_id: committedAccount },
      }),
    ).toMatchObject({ available_micros: 1n, subject_id: "committed" });
    expect(
      await fixture.client.entitlement_command_receipt.findFirstOrThrow({
        where: { idempotency_key: "committed" },
      }),
    ).toMatchObject({
      status: "succeeded",
      result_json: { account: committedAccount, result: "credited" },
    });
    expect(
      await fixture.client.entitlement_credit_account.count({
        where: { subject_id: "rolled-back" },
      }),
    ).toBe(0);
  });

  it("surfaces real CHECK and partial UNIQUE errors, including concurrent distinct backends", async () => {
    await expect(
      fixture.client.entitlement_credit_account.create({
        data: {
          credit_account_id: id(),
          tenant_id: "tenant",
          subject_id: "bad",
          available_micros: -1n,
        },
      }),
    ).rejects.toMatchObject({ code: "P2039", meta: anyObject });
    const identity = id();
    const backendPids: number[] = [];
    const runConcurrentCreates = async (failIndex?: number) => {
      let releaseCreates!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreates = resolve;
      });
      const arrivals = [0, 1].map(() => {
        let resolveArrival!: () => void;
        let rejectArrival!: (error: unknown) => void;
        const promise = new Promise<void>((resolve, reject) => {
          resolveArrival = resolve;
          rejectArrival = reject;
        });
        return { promise, resolveArrival, rejectArrival };
      });
      const workers = ["key-a", "key-b"].map((key, index) =>
        (async () => {
          let arrived = false;
          try {
            return await fixture.client.$transaction(
              async (tx) => {
                if (index === failIndex) {
                  await assertDefined(arrivals[index === 0 ? 1 : 0]).promise;
                  throw new Error("early fixture failure");
                }
                const pid = await tx.$queryRaw<
                  Array<{ pid: number }>
                >`SELECT pg_catalog.pg_backend_pid() AS pid`;
                backendPids.push(assertDefined(pid[0]).pid);
                arrived = true;
                assertDefined(arrivals[index]).resolveArrival();
                await createGate;
                if (failIndex !== undefined) return assertDefined(pid[0]).pid;
                await tx.entitlement_command_receipt.create({
                  data: {
                    receipt_id: id(),
                    tenant_id: "tenant",
                    command_name: "same",
                    command_identity: identity,
                    idempotency_key: key,
                    payload_hash: hash,
                  },
                });
                return assertDefined(pid[0]).pid;
              },
              { timeout: 2_000 },
            );
          } catch (error) {
            if (!arrived) assertDefined(arrivals[index]).rejectArrival(error);
            throw error;
          }
        })(),
      );
      let primaryError: unknown;
      let hasPrimaryError = false;
      let results: PromiseSettledResult<number>[] = [];
      try {
        await Promise.all(arrivals.map(({ promise }) => promise));
        releaseCreates();
        results = await Promise.allSettled(workers);
      } catch (error) {
        primaryError = error;
        hasPrimaryError = true;
      } finally {
        releaseCreates();
        if (results.length === 0) results = await Promise.allSettled(workers);
      }
      if (hasPrimaryError) throw primaryError;
      return results;
    };
    await expect(runConcurrentCreates(0)).rejects.toThrow(
      "early fixture failure",
    );
    backendPids.length = 0;
    const results = await runConcurrentCreates();
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "P2002", meta: anyObject },
    });
    expect(new Set(backendPids).size).toBe(2);
    const winner =
      await fixture.client.entitlement_command_receipt.findFirstOrThrow({
        where: { tenant_id: "tenant", command_name: "same" },
      });
    await expect(
      fixture.client.entitlement_command_receipt.create({
        data: {
          receipt_id: id(),
          tenant_id: "tenant",
          command_name: "same",
          command_identity: id(),
          idempotency_key: winner.idempotency_key,
          payload_hash: hash,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002", meta: anyObject });
    await fixture.client.entitlement_command_receipt.create({
      data: {
        receipt_id: id(),
        tenant_id: "other-tenant",
        command_name: "same",
        command_identity: identity,
        idempotency_key: winner.idempotency_key,
        payload_hash: hash,
      },
    });
  });

  it("uses parameterized row locks, SKIP LOCKED, and independent transaction budgets", async () => {
    const accountId = id();
    await fixture.client.entitlement_credit_account.create({
      data: {
        credit_account_id: accountId,
        tenant_id: "tenant",
        subject_id: "locked",
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    let lockFailed!: (error: unknown) => void;
    let holderPid = 0;
    const acquired = new Promise<void>((resolve, reject) => {
      locked = resolve;
      lockFailed = reject;
    });
    const holder = fixture.client.$transaction(
      async (tx) => {
        const backend = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_catalog.pg_backend_pid() AS pid`;
        holderPid = assertDefined(backend[0]).pid;
        await tx.$queryRaw`SELECT credit_account_id FROM public.entitlement_credit_account WHERE tenant_id = ${"tenant"} AND credit_account_id = ${accountId} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 2_000 },
    );
    void holder.catch(lockFailed);
    let contender: Promise<Array<{ credit_account_id: string }>> | undefined;
    try {
      await acquired;
      expect(
        await fixture.client
          .$queryRaw`SELECT credit_account_id FROM public.entitlement_credit_account WHERE tenant_id = ${"wrong-tenant"} AND credit_account_id = ${accountId} FOR UPDATE`,
      ).toEqual([]);
      const skipped = await fixture.client.$transaction(
        (tx) =>
          tx.$queryRaw<
            Array<{ credit_account_id: string }>
          >`SELECT credit_account_id FROM public.entitlement_credit_account WHERE tenant_id = ${"tenant"} AND credit_account_id = ${accountId} FOR UPDATE SKIP LOCKED`,
      );
      expect(skipped).toEqual([]);
      await expect(
        fixture.client.$transaction(async (tx) => {
          const setting = await tx.$queryRaw<
            Array<{ value: string }>
          >`SELECT pg_catalog.set_config('lock_timeout', '50ms', true) AS value`;
          expect(setting).toEqual([{ value: "50ms" }]);
          await tx.$queryRaw`SELECT credit_account_id FROM public.entitlement_credit_account WHERE tenant_id = ${"tenant"} AND credit_account_id = ${accountId} FOR UPDATE`;
        }),
      ).rejects.toMatchObject({
        code: "P2010",
        meta: { driverAdapterError: { cause: { code: "55P03" } } },
      });
      contender = fixture.client.$transaction(
        (tx) =>
          tx.$queryRaw<
            Array<{ credit_account_id: string }>
          >`SELECT credit_account_id FROM public.entitlement_credit_account WHERE tenant_id = ${"tenant"} AND credit_account_id = ${accountId} FOR UPDATE`,
      );
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
        const state = await fixture.pool.query<{ waiting: boolean }>(
          `SELECT pg_catalog.bool_or(wait_event_type = 'Lock') AS waiting
         FROM pg_catalog.pg_stat_activity
         WHERE datname = pg_catalog.current_database() AND pid <> $1`,
          [holderPid],
        );
        waiting = state.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await Promise.allSettled([holder, ...(contender ? [contender] : [])]);
    }
    await holder;
    expect(await contender).toEqual([{ credit_account_id: accountId }]);
    await expect(
      fixture.client.$transaction(
        async (tx) => {
          const setting = await tx.$queryRaw<
            Array<{ value: string }>
          >`SELECT pg_catalog.set_config('statement_timeout', '30ms', true) AS value`;
          expect(setting).toEqual([{ value: "30ms" }]);
          await tx.$queryRaw`SELECT 1 AS value FROM pg_catalog.pg_sleep(1)`;
        },
        { timeout: 2_000 },
      ),
    ).rejects.toMatchObject({
      code: "P2010",
      meta: { driverAdapterError: { cause: { code: "57014" } } },
    });
    await expect(
      fixture.client.$transaction(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
        { timeout: 25 },
      ),
    ).rejects.toMatchObject({ code: "P2028" });
  });
});
