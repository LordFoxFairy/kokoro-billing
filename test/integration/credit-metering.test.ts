import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditAppender } from "../../src/database/audit-appender.js";
import type { AuditAppendInput } from "../../src/database/audit.types.js";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { commandDigest } from "../../src/database/canonical-digest.js";
import { OutboxRepository } from "../../src/database/outbox.repository.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { DatabaseModule } from "../../src/database/database.module.js";
import { CreditModule } from "../../src/modules/credit/credit.module.js";
import { CreditRepository } from "../../src/modules/credit/credit.repository.js";
import {
  CreditEffects,
  CreditService,
} from "../../src/modules/credit/credit.service.js";
import type { HoldTerminalResult } from "../../src/modules/credit/credit.types.js";
import { MeteringRepository } from "../../src/modules/metering/metering.repository.js";
import { MeteringService } from "../../src/modules/metering/metering.service.js";
import { MeteringModule } from "../../src/modules/metering/metering.module.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(adminUrl === undefined)(
  "credit and metering transaction group",
  () => {
    let fixture: PrismaDatabaseFixture | undefined;
    let tx: TransactionService;
    let credit: CreditService;
    let effects: CreditEffects;
    beforeEach(async () => {
      fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
      tx = new TransactionService(fixture.client);
      const repository = new CreditRepository(tx);
      effects = new CreditEffects(tx, repository, new AuditAppender(tx));
      credit = new CreditService(tx, new CommandReceiptRepository(tx), effects);
    });
    afterEach(async () => {
      await fixture?.close();
      fixture = undefined;
    });

    const grant = (key = "grant-1") =>
      credit.grant({
        tenantId: "tenant",
        actorId: "operator",
        subjectId: "subject",
        amountMicros: 100n,
        sourceKind: "admin",
        sourceRef: "source-1",
        programKey: "program",
        effectiveAt: new Date("2026-01-01T00:00:00Z"),
        idempotencyKey: key,
        commandIdentity: "grant-identity",
      });

    const reserveFacts = async () => {
      const client = assertDefined(fixture).client;
      const query = {
        where: { tenant_id: "tenant" },
        orderBy: { id: "asc" as const },
      };
      const [
        accounts,
        grants,
        holds,
        allocations,
        journals,
        receipts,
        bindings,
        audits,
        outbox,
      ] = await Promise.all([
        client.billing_credit_account.findMany(query),
        client.billing_credit_grant.findMany(query),
        client.billing_credit_hold.findMany(query),
        client.billing_credit_hold_allocation.findMany(query),
        client.billing_credit_journal.findMany(query),
        client.billing_command_receipt.findMany(query),
        client.billing_command_key_binding.findMany(query),
        client.billing_audit_event.findMany(query),
        client.billing_outbox.findMany(query),
      ]);
      return {
        accounts,
        grants,
        holds,
        allocations,
        journals,
        receipts,
        bindings,
        audits,
        outbox,
      };
    };

    describe("R34 C1 terminal identity RED", () => {
      const scope = (operation: string, tenantId = "tenant") => ({
        tenantId,
        actorId: "terminal-service",
        operation,
        mode: "write" as const,
      });
      const otherGrant = (subject = "other-subject", tenantId = "tenant") =>
        credit.grant({
          tenantId,
          actorId: "operator",
          subjectId: subject,
          amountMicros: 100n,
          sourceKind: "admin",
          sourceRef: `grant-${subject}`,
          programKey: "program",
          effectiveAt: new Date("2026-01-01T00:00:00Z"),
          idempotencyKey: `grant-${subject}`,
        });
      const holdFor = (accountId: string, key: string, tenantId = "tenant") =>
        credit.reserve({
          tenantId,
          actorId: "terminal-service",
          accountId,
          requestedMicros: 40n,
          featureKey: "chat",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          idempotencyKey: key,
        });
      const finish = (
        action: "capture" | "release",
        holdId: string,
        sourceRef: string,
        actualMicros = 30n,
        owner = { tx, effects },
        tenantId = "tenant",
      ): Promise<HoldTerminalResult> =>
        owner.tx.runRoot(scope(`credit.${action}`, tenantId), () =>
          action === "capture"
            ? owner.effects.capture({
                tenantId,
                holdId,
                sourceRef,
                actualMicros,
              })
            : owner.effects.release({ tenantId, holdId, sourceRef }),
        );

      // JSON text preserves every persisted column (including bigint/timestamps and
      // a future terminal_source_ref), without depending on a not-yet-generated field.
      // No tenant filter: corruption must not disappear from the independent snapshot.
      const terminalFacts = async () => {
        const pool = assertDefined(fixture).pool;
        const queries = [
          "SELECT row_to_json(a)::text AS fact FROM billing_credit_account a ORDER BY a.id",
          "SELECT row_to_json(g)::text AS fact FROM billing_credit_grant g ORDER BY g.id",
          "SELECT row_to_json(h)::text AS fact FROM billing_credit_hold h ORDER BY h.id",
          "SELECT row_to_json(a)::text AS fact FROM billing_credit_hold_allocation a ORDER BY a.id",
          "SELECT row_to_json(j)::text AS fact FROM billing_credit_journal j ORDER BY j.id",
          "SELECT row_to_json(r)::text AS fact FROM billing_command_receipt r ORDER BY r.id",
          "SELECT row_to_json(k)::text AS fact FROM billing_command_key_binding k ORDER BY k.id",
          "SELECT row_to_json(a)::text AS fact FROM billing_audit_event a ORDER BY a.id",
          "SELECT row_to_json(o)::text AS fact FROM billing_outbox o ORDER BY o.id",
        ] as const;
        const facts = await Promise.all(
          queries.map(async (sql) =>
            (await pool.query<{ fact: string }>(sql)).rows.map(
              ({ fact }) => fact,
            ),
          ),
        );
        return {
          accounts: facts[0],
          grants: facts[1],
          holds: facts[2],
          allocations: facts[3],
          journals: facts[4],
          receipts: facts[5],
          bindings: facts[6],
          audits: facts[7],
          outbox: facts[8],
        };
      };
      const terminalSource = async (holdId: string) => {
        const pool = assertDefined(fixture).pool;
        const columns = await pool.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_credit_hold' AND column_name='terminal_source_ref'",
        );
        expect(
          columns.rows,
          "canonical terminal source column is required",
        ).toEqual([{ column_name: "terminal_source_ref" }]);
        const rows = await pool.query<{ terminal_source_ref: string | null }>(
          "SELECT terminal_source_ref FROM billing_credit_hold WHERE id=$1::uuid",
          [holdId],
        );
        return assertDefined(rows.rows[0]).terminal_source_ref;
      };
      const assertFirstTerminal = async (
        holdId: string,
        accountId: string,
        action: "capture" | "release",
        actualMicros: bigint,
        sourceRef: string,
      ) => {
        const client = assertDefined(fixture).client;
        const captured = action === "capture" ? actualMicros : 0n;
        expect(
          await client.billing_credit_hold.findUniqueOrThrow({
            where: { id: holdId },
          }),
        ).toMatchObject({
          tenant_id: "tenant",
          credit_account_id: accountId,
          status: action === "capture" ? "captured" : "released",
          requested_micros: 40n,
          captured_micros: captured,
          released_micros: 40n - captured,
        });
        const allocations =
          await client.billing_credit_hold_allocation.findMany({
            where: { credit_hold_id: holdId },
          });
        expect(allocations).toHaveLength(1);
        expect(allocations[0]).toMatchObject({
          held_micros: 40n,
          captured_micros: captured,
          released_micros: 40n - captured,
        });
        const debits = await client.billing_credit_journal.findMany({
          where: {
            tenant_id: "tenant",
            source_kind: "usage",
            source_ref: sourceRef,
            entry_kind: "debit",
          },
        });
        expect(debits).toHaveLength(captured > 0n ? 1 : 0);
        if (captured > 0n)
          expect(debits[0]).toMatchObject({
            credit_account_id: accountId,
            amount_micros: -captured,
          });
        expect(await terminalSource(holdId)).toBe(sourceRef);
      };
      const createPeer = () => {
        const pool = new Pool({
          connectionString: assertDefined(fixture).url,
          max: 2,
          connectionTimeoutMillis: 2_000,
          options:
            "-c search_path=public,pg_catalog -c timezone=UTC -c statement_timeout=5000 -c lock_timeout=2000",
        });
        const client = new PrismaClient({ adapter: new PrismaPg(pool) });
        const peerTx = new TransactionService(client);
        return {
          tx: peerTx,
          effects: new CreditEffects(
            peerTx,
            new CreditRepository(peerTx),
            new AuditAppender(peerTx),
          ),
          async close() {
            try {
              await client.$disconnect();
            } finally {
              await pool.end();
            }
          },
        };
      };

      test.each(["forward", "reverse"] as const)(
        "T01 two captures on one account replay in %s order without any new fact",
        async (order) => {
          const account = await grant();
          const a = await holdFor(account.accountId, "terminal-a");
          const b = await holdFor(account.accountId, "terminal-b");
          const first = await finish("capture", a.holdId, "usage-a", 30n);
          const second = await finish("capture", b.holdId, "usage-b", 20n);
          expect(first).toEqual({
            holdId: a.holdId,
            accountId: account.accountId,
            capturedMicros: 30n,
            releasedMicros: 10n,
          });
          expect(second).toEqual({
            holdId: b.holdId,
            accountId: account.accountId,
            capturedMicros: 20n,
            releasedMicros: 20n,
          });
          const before = await terminalFacts();
          const requests =
            order === "forward"
              ? ([
                  [a.holdId, "usage-a", 30n, first],
                  [b.holdId, "usage-b", 20n, second],
                ] as const)
              : ([
                  [b.holdId, "usage-b", 20n, second],
                  [a.holdId, "usage-a", 30n, first],
                ] as const);
          for (const [id, source, amount, expected] of requests) {
            await expect(
              finish("capture", id, source, amount),
            ).resolves.toEqual(expected);
            expect(await terminalFacts()).toEqual(before);
          }
          await assertFirstTerminal(
            a.holdId,
            account.accountId,
            "capture",
            30n,
            "usage-a",
          );
          await assertFirstTerminal(
            b.holdId,
            account.accountId,
            "capture",
            20n,
            "usage-b",
          );
          expect(
            await assertDefined(
              fixture,
            ).client.billing_credit_account.findUniqueOrThrow({
              where: { id: account.accountId },
            }),
          ).toMatchObject({
            available_micros: 50n,
            held_micros: 0n,
            generation: 6n,
          });
        },
      );

      test.each(["capture", "release"] as const)(
        "T02/T03 %s at zero binds its source and replays without audit or zero journal",
        async (action) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "zero-terminal");
          const result = await finish(action, hold.holdId, "zero-source", 0n);
          expect(result).toEqual({
            holdId: hold.holdId,
            accountId: account.accountId,
            capturedMicros: 0n,
            releasedMicros: 40n,
          });
          const before = await terminalFacts();
          await expect(
            finish(action, hold.holdId, "zero-source", 0n),
          ).resolves.toEqual(result);
          expect(await terminalFacts()).toEqual(before);
          await assertFirstTerminal(
            hold.holdId,
            account.accountId,
            action,
            0n,
            "zero-source",
          );
          expect(
            await assertDefined(
              fixture,
            ).client.billing_credit_account.findUniqueOrThrow({
              where: { id: account.accountId },
            }),
          ).toMatchObject({
            available_micros: 100n,
            held_micros: 0n,
            generation: 4n,
          });
          expect(
            await assertDefined(
              fixture,
            ).client.billing_credit_grant.findUniqueOrThrow({
              where: { id: account.grantId },
            }),
          ).toMatchObject({ remaining_micros: 100n });
        },
      );

      test.each(
        (["capture", "release"] as const).flatMap((action) =>
          (["source", "action"] as const).map((drift) => ({ action, drift })),
        ),
      )(
        "T02/T03 $action rejects zero-terminal $drift drift atomically",
        async ({ action, drift }) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "zero-drift");
          await finish(action, hold.holdId, "original", 0n);
          const before = await terminalFacts();
          await expect(
            finish(
              drift === "action"
                ? action === "capture"
                  ? "release"
                  : "capture"
                : action,
              hold.holdId,
              drift === "source" ? "different" : "original",
              0n,
            ),
          ).rejects.toMatchObject({ code: "CREDIT_IDEMPOTENCY_CONFLICT" });
          expect(await terminalFacts()).toEqual(before);
        },
      );

      test.each(["amount", "source", "another-valid-source"] as const)(
        "T04 positive capture rejects %s drift without changing any fact",
        async (drift) => {
          const account = await grant();
          const a = await holdFor(account.accountId, "drift-a");
          const b = await holdFor(account.accountId, "drift-b");
          await finish("capture", a.holdId, "drift-source-a", 30n);
          await finish("capture", b.holdId, "drift-source-b", 20n);
          const before = await terminalFacts();
          await expect(
            finish(
              "capture",
              a.holdId,
              drift === "amount"
                ? "drift-source-a"
                : drift === "source"
                  ? "unknown-source"
                  : "drift-source-b",
              drift === "amount" ? 31n : 30n,
            ),
          ).rejects.toMatchObject({ code: "CREDIT_IDEMPOTENCY_CONFLICT" });
          expect(await terminalFacts()).toEqual(before);
        },
      );

      type TerminalAttempt = Readonly<{
        action: "capture" | "release";
        sourceRef: string;
        actualMicros: bigint;
      }>;
      const finishContended = async (
        accountId: string,
        holdId: string,
        attempts: readonly [TerminalAttempt, TerminalAttempt],
        peer: ReturnType<typeof createPeer>,
        before: Awaited<ReturnType<typeof terminalFacts>>,
      ) => {
        const target = assertDefined(fixture);
        const blocker = await target.pool.connect();
        const backendIds: number[] = [];
        const settled = [false, false];
        let pending:
          Promise<PromiseSettledResult<HoldTerminalResult>[]> | undefined;
        try {
          await blocker.query("BEGIN");
          const blockerPid = assertDefined(
            (
              await blocker.query<{ pid: number }>(
                "SELECT pg_backend_pid() AS pid",
              )
            ).rows[0],
          ).pid;
          const locked = await blocker.query(
            "SELECT id FROM billing_credit_account WHERE id=$1::uuid AND tenant_id=$2 FOR UPDATE",
            [accountId, "tenant"],
          );
          expect(locked.rowCount).toBe(1);
          const owners = [{ tx, effects }, peer] as const;
          pending = Promise.allSettled(
            attempts.map((attempt, index) => {
              const owner = assertDefined(owners[index]);
              return owner.tx
                .runRoot(scope(`credit.${attempt.action}`), async () => {
                  // Record the actual effect transaction's backend, not a pool probe.
                  const rows = await owner.tx.requireActiveTransaction(
                    "tenant",
                    "write",
                  ).$queryRaw<
                    Array<{ pid: number }>
                  >`SELECT pg_backend_pid() AS pid`;
                  backendIds[index] = assertDefined(rows[0]).pid;
                  return attempt.action === "capture"
                    ? owner.effects.capture({
                        tenantId: "tenant",
                        holdId,
                        sourceRef: attempt.sourceRef,
                        actualMicros: attempt.actualMicros,
                      })
                    : owner.effects.release({
                        tenantId: "tenant",
                        holdId,
                        sourceRef: attempt.sourceRef,
                      });
                })
                .then(
                  (value) => {
                    settled[index] = true;
                    return value;
                  },
                  (error: unknown) => {
                    settled[index] = true;
                    throw error;
                  },
                );
            }),
          );
          let waiting: Array<{
            pid: number;
            state: string;
            wait_event_type: string | null;
            blockers: number[];
            query: string;
          }> = [];
          const bothBlockedByFixture = () => {
            // The second waiter can queue behind the first tuple-lock waiter.
            // Resolve that exact two-backend chain to our lock holder; arbitrary
            // unrelated blocked backends cannot satisfy this barrier.
            const blocked = new Set([blockerPid]);
            for (let pass = 0; pass < 2; pass += 1)
              for (const row of waiting)
                if (row.blockers.some((pid) => blocked.has(pid)))
                  blocked.add(row.pid);
            return (
              waiting.length === 2 &&
              waiting.every(
                (row) =>
                  row.state === "active" &&
                  row.wait_event_type === "Lock" &&
                  row.query.includes("billing_credit_account") &&
                  blocked.has(row.pid),
              )
            );
          };
          for (let attempt = 0; attempt < 40; attempt += 1) {
            if (backendIds.filter((pid) => pid !== undefined).length === 2) {
              waiting = (
                await target.pool.query<{
                  pid: number;
                  state: string;
                  wait_event_type: string | null;
                  blockers: number[];
                  query: string;
                }>(
                  "SELECT pid,state,wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[]) ORDER BY pid",
                  [backendIds],
                )
              ).rows;
              if (bothBlockedByFixture()) break;
            }
            // Poll pacing only; the catalog blocker/PID assertions are proof.
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(backendIds).toHaveLength(2);
          expect(new Set(backendIds).size).toBe(2);
          expect(backendIds).not.toContain(blockerPid);
          expect(waiting.map(({ pid }) => pid).sort((a, b) => a - b)).toEqual(
            [...backendIds].sort((a, b) => a - b),
          );
          expect(
            bothBlockedByFixture(),
            "both exact effect backends must wait for our account lock",
          ).toBe(true);
          expect(settled).toEqual([false, false]);
          expect(await terminalFacts()).toEqual(before);
          expect(settled).toEqual([false, false]);
          // Neither contender can commit before this deliberate release.
          await blocker.query("ROLLBACK");
          return await pending;
        } finally {
          try {
            await blocker.query("ROLLBACK");
          } finally {
            blocker.release();
            // Release and drain both transactions even when the barrier fails.
            if (pending) await pending;
          }
        }
      };

      test.each([
        { action: "capture" as const, amount: 30n },
        { action: "capture" as const, amount: 0n },
        { action: "release" as const, amount: 0n },
      ])(
        "T05 concurrent identical $action/$amount has one effect and one audit",
        async ({ action, amount }) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "concurrent-terminal");
          const before = await terminalFacts();
          const peer = createPeer();
          try {
            const results = await finishContended(
              account.accountId,
              hold.holdId,
              [
                {
                  action,
                  sourceRef: "concurrent-source",
                  actualMicros: amount,
                },
                {
                  action,
                  sourceRef: "concurrent-source",
                  actualMicros: amount,
                },
              ],
              peer,
              before,
            );
            expect(results.map((result) => result.status)).toEqual([
              "fulfilled",
              "fulfilled",
            ]);
            const first = assertDefined(results[0]);
            const second = assertDefined(results[1]);
            if (first.status !== "fulfilled" || second.status !== "fulfilled")
              throw new Error("Both identical terminal requests must succeed");
            expect(first.value).toEqual(second.value);
            expect(first.value).toEqual({
              holdId: hold.holdId,
              accountId: account.accountId,
              capturedMicros: amount,
              releasedMicros: 40n - amount,
            });
            const after = await terminalFacts();
            expect(after.audits).toHaveLength(
              assertDefined(before.audits).length + 1,
            );
            expect(after.receipts).toEqual(before.receipts);
            expect(after.bindings).toEqual(before.bindings);
            expect(after.outbox).toEqual(before.outbox);
            await assertFirstTerminal(
              hold.holdId,
              account.accountId,
              action,
              amount,
              "concurrent-source",
            );
            expect(
              await assertDefined(
                fixture,
              ).client.billing_credit_account.findUniqueOrThrow({
                where: { id: account.accountId },
              }),
            ).toMatchObject({
              available_micros: 100n - amount,
              held_micros: 0n,
              generation: 4n,
            });
            expect(
              await assertDefined(
                fixture,
              ).client.billing_credit_grant.findUniqueOrThrow({
                where: { id: account.grantId },
              }),
            ).toMatchObject({ remaining_micros: 100n - amount });
          } finally {
            await peer.close();
          }
        },
      );

      test.each(["source", "amount", "action"] as const)(
        "T05 competing %s payloads commit exactly one terminal",
        async (drift) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "competing-terminal");
          const before = await terminalFacts();
          const peer = createPeer();
          try {
            const results = await finishContended(
              account.accountId,
              hold.holdId,
              [
                {
                  action: "capture",
                  sourceRef: "competing-a",
                  actualMicros: 0n,
                },
                {
                  action: drift === "action" ? "release" : "capture",
                  sourceRef: drift === "source" ? "competing-b" : "competing-a",
                  actualMicros: drift === "amount" ? 1n : 0n,
                },
              ],
              peer,
              before,
            );
            expect(
              results.filter((result) => result.status === "fulfilled"),
            ).toHaveLength(1);
            const loser = assertDefined(
              results.find((result) => result.status === "rejected"),
            );
            if (loser.status !== "rejected")
              throw new Error("One competitor must reject");
            expect(loser.reason).toMatchObject({
              code: "CREDIT_IDEMPOTENCY_CONFLICT",
            });
            const after = await terminalFacts();
            expect(after.audits).toHaveLength(
              assertDefined(before.audits).length + 1,
            );
            expect(after.receipts).toEqual(before.receipts);
            expect(after.bindings).toEqual(before.bindings);
            expect(after.outbox).toEqual(before.outbox);
            const row = await assertDefined(
              fixture,
            ).client.billing_credit_hold.findUniqueOrThrow({
              where: { id: hold.holdId },
            });
            const winner = assertDefined(
              results.find((result) => result.status === "fulfilled"),
            );
            if (winner.status !== "fulfilled")
              throw new Error("One competitor must succeed");
            expect(winner.value).toEqual({
              holdId: hold.holdId,
              accountId: account.accountId,
              capturedMicros: row.captured_micros,
              releasedMicros: row.released_micros,
            });
            const source = await terminalSource(hold.holdId);
            const firstWon = results[0]?.status === "fulfilled";
            expect(source).toBe(
              !firstWon && drift === "source" ? "competing-b" : "competing-a",
            );
            expect(row.status).toBe(
              !firstWon && drift === "action" ? "released" : "captured",
            );
            expect(row.captured_micros).toBe(
              !firstWon && drift === "amount" ? 1n : 0n,
            );
            await expect(
              finish(
                row.status === "captured" ? "capture" : "release",
                hold.holdId,
                assertDefined(source),
                row.captured_micros,
              ),
            ).resolves.toEqual(winner.value);
            expect(await terminalFacts()).toEqual(after);
          } finally {
            await peer.close();
          }
        },
      );

      test.each([
        { first: 30n, second: 20n },
        { first: 0n, second: 0n },
        { first: 30n, second: 0n },
        { first: 0n, second: 30n },
      ])(
        "T06 cross-hold capture source reuse $first/$second conflicts with full rollback",
        async ({ first, second }) => {
          const account = await grant();
          const a = await holdFor(account.accountId, "source-reuse-a");
          const b = await holdFor(account.accountId, "source-reuse-b");
          await finish("capture", a.holdId, "shared-capture-source", first);
          const before = await terminalFacts();
          await expect(
            finish("capture", b.holdId, "shared-capture-source", second),
          ).rejects.toMatchObject({ code: "CREDIT_IDEMPOTENCY_CONFLICT" });
          expect(await terminalFacts()).toEqual(before);
        },
      );

      test("T06 release source may legitimately terminate two holds", async () => {
        const account = await grant();
        const a = await holdFor(account.accountId, "release-shared-a");
        const b = await holdFor(account.accountId, "release-shared-b");
        await finish("release", a.holdId, "shared-cancel", 0n);
        await finish("release", b.holdId, "shared-cancel", 0n);
        await assertFirstTerminal(
          a.holdId,
          account.accountId,
          "release",
          0n,
          "shared-cancel",
        );
        await assertFirstTerminal(
          b.holdId,
          account.accountId,
          "release",
          0n,
          "shared-cancel",
        );
        const before = await terminalFacts();
        await finish("release", a.holdId, "shared-cancel", 0n);
        await finish("release", b.holdId, "shared-cancel", 0n);
        expect(await terminalFacts()).toEqual(before);
      });

      test.each(
        [
          { action: "capture" as const, amount: 30n },
          { action: "capture" as const, amount: 0n },
          { action: "release" as const, amount: 0n },
        ].flatMap((item) =>
          [false, true].map((caught) => ({ ...item, caught })),
        ),
      )(
        "T07 $action/$amount audit inserted then thrown rolls back root facts (caught=$caught)",
        async ({ action, amount, caught }) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "audit-terminal");
          const before = await terminalFacts();
          class InsertThenFailAudit extends AuditAppender {
            attempts = 0;
            override async append(input: AuditAppendInput): Promise<string> {
              await super.append(input);
              this.attempts += 1;
              throw new Error("terminal audit inserted tail");
            }
          }
          const audit = new InsertThenFailAudit(tx);
          const failing = new CreditEffects(
            tx,
            new CreditRepository(tx),
            audit,
          );
          const receipts = new CommandReceiptRepository(tx);
          const outbox = new OutboxRepository(tx, new AuditAppender(tx));
          const invoke = (selected: CreditEffects, swallow: boolean) =>
            tx.runRoot(scope("terminal-atomic-group"), async () =>
              receipts.execute(
                {
                  tenantId: "tenant",
                  namespace: "general",
                  commandName: "terminal-proof",
                  commandIdentity: "terminal-proof-identity",
                  idempotencyKey: "terminal-proof-key",
                  requestSchemaVersion: 1,
                  payloadDigest: commandDigest({
                    action,
                    amount,
                    holdId: hold.holdId,
                    source: "audit-source",
                  }),
                },
                {
                  schemaVersion: 1,
                  encode: (value: boolean) => value,
                  decode: (value: unknown) => {
                    if (value !== true)
                      throw new TypeError("terminal proof result corrupt");
                    return value;
                  },
                },
                async () => {
                  // A registered event is an outer transaction sentinel, not a new
                  // Credit notification or a receiver ACK.
                  await outbox.enqueue({
                    tenantId: "tenant",
                    namespace: "payment",
                    aggregateType: "refund",
                    aggregateId: hold.holdId,
                    eventType: "RefundCreditEffectRequested",
                    eventIdentity: "terminal-tail-event",
                    payloadSchemaVersion: 1,
                    payloadDigest: commandDigest({ holdId: hold.holdId }),
                    payload: { holdId: hold.holdId },
                  });
                  const mutation = () =>
                    action === "capture"
                      ? selected.capture({
                          tenantId: "tenant",
                          holdId: hold.holdId,
                          sourceRef: "audit-source",
                          actualMicros: amount,
                        })
                      : selected.release({
                          tenantId: "tenant",
                          holdId: hold.holdId,
                          sourceRef: "audit-source",
                        });
                  if (swallow) {
                    try {
                      await mutation();
                    } catch (error) {
                      expect(error).toMatchObject({
                        message: "terminal audit inserted tail",
                      });
                    }
                  } else {
                    await mutation();
                  }
                  return true;
                },
              ),
            );
          await expect(invoke(failing, caught)).rejects.toThrow(
            "terminal audit inserted tail",
          );
          expect(audit.attempts).toBe(1);
          expect(await terminalFacts()).toEqual(before);
          await expect(invoke(effects, false)).resolves.toMatchObject({
            replayed: false,
            value: true,
          });
          const after = await terminalFacts();
          expect(after.audits).toHaveLength(
            assertDefined(before.audits).length + 1,
          );
          expect(after.receipts).toHaveLength(
            assertDefined(before.receipts).length + 1,
          );
          expect(after.bindings).toHaveLength(
            assertDefined(before.bindings).length + 1,
          );
          expect(after.outbox).toHaveLength(
            assertDefined(before.outbox).length + 1,
          );
          await assertFirstTerminal(
            hold.holdId,
            account.accountId,
            action,
            amount,
            "audit-source",
          );
          await expect(invoke(effects, false)).resolves.toMatchObject({
            replayed: true,
            value: true,
          });
          expect(await terminalFacts()).toEqual(after);
        },
      );

      test.each(["capture", "release"] as const)(
        "T08 explicit expired fixture rejects %s rather than replaying another action",
        async (action) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "explicit-expired");
          await finish("release", hold.holdId, "expiry-batch", 0n);
          const pool = assertDefined(fixture).pool;
          await pool.query(
            "UPDATE billing_credit_hold SET status='expired' WHERE id=$1::uuid",
            [hold.holdId],
          );
          const before = await terminalFacts();
          await expect(
            finish(action, hold.holdId, "expiry-batch", 0n),
          ).rejects.toMatchObject({ code: "CREDIT_IDEMPOTENCY_CONFLICT" });
          expect(await terminalFacts()).toEqual(before);
          expect(await terminalSource(hold.holdId)).toBe("expiry-batch");
          // A stored expired row is classification evidence, not expiry worker proof.
        },
      );
      test.each(["capture", "release"] as const)(
        "T08 active past TTL still allows %s without auto-expired classification",
        async (action) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "past-ttl");
          await assertDefined(fixture).pool.query(
            "UPDATE billing_credit_hold SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1::uuid",
            [hold.holdId],
          );
          await expect(
            finish(action, hold.holdId, "past-ttl-source", 0n),
          ).resolves.toMatchObject({
            capturedMicros: 0n,
            releasedMicros: 40n,
          });
          await assertFirstTerminal(
            hold.holdId,
            account.accountId,
            action,
            0n,
            "past-ttl-source",
          );
        },
      );
      test.each(["positive", "zero", "release"] as const)(
        "T08 committed %s replay ignores later account disable and grant expiry",
        async (kind) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "later-window");
          const action = kind === "release" ? "release" : "capture";
          const amount = kind === "positive" ? 30n : 0n;
          const result = await finish(
            action,
            hold.holdId,
            "window-source",
            amount,
          );
          await assertDefined(fixture).client.billing_credit_account.update({
            where: { id: account.accountId },
            data: { status: "disabled" },
          });
          await assertDefined(fixture).client.billing_credit_grant.update({
            where: { id: account.grantId },
            data: {
              status: "expired",
              expires_at: new Date("2026-02-01T00:00:00Z"),
            },
          });
          const before = await terminalFacts();
          await expect(
            finish(action, hold.holdId, "window-source", amount),
          ).resolves.toEqual(result);
          expect(await terminalFacts()).toEqual(before);
        },
      );

      test.each([
        "missing",
        "wrong-amount",
        "wrong-account",
        "duplicate",
        "duplicate-cross-account",
      ] as const)(
        "T09 positive replay fails closed for %s matching debit",
        async (damage) => {
          const account = await grant();
          const other = await otherGrant();
          const hold = await holdFor(account.accountId, "corrupt-debit");
          await finish("capture", hold.holdId, "corrupt-source", 30n);
          const target = assertDefined(fixture);
          const debit =
            await target.client.billing_credit_journal.findFirstOrThrow({
              where: {
                tenant_id: "tenant",
                entry_kind: "debit",
                source_kind: "usage",
                source_ref: "corrupt-source",
              },
            });
          const duplicate =
            damage === "duplicate" || damage === "duplicate-cross-account";
          const injectedId = randomUUID();
          try {
            if (duplicate) {
              // Only this per-test temporary database loses its existing constraint.
              await target.pool.query(
                "ALTER TABLE billing_credit_journal DROP CONSTRAINT uq_billing_credit_journal_source",
              );
              await target.client.billing_credit_journal.create({
                data: {
                  id: injectedId,
                  tenant_id: debit.tenant_id,
                  credit_account_id:
                    damage === "duplicate"
                      ? account.accountId
                      : other.accountId,
                  journal_seq: 100n,
                  entry_kind: "debit",
                  source_kind: "usage",
                  source_ref: debit.source_ref,
                  amount_micros: damage === "duplicate" ? -30n : -31n,
                },
              });
            } else if (damage === "missing") {
              await target.client.billing_credit_journal.delete({
                where: { id: debit.id },
              });
            } else {
              await target.client.billing_credit_journal.update({
                where: { id: debit.id },
                data:
                  damage === "wrong-amount"
                    ? { amount_micros: -31n }
                    : { credit_account_id: other.accountId },
              });
            }
            const matches = await target.pool.query<{
              id: string;
              account: string;
              amount: string;
            }>(
              "SELECT id,credit_account_id AS account,amount_micros::text AS amount FROM billing_credit_journal WHERE tenant_id=$1 AND entry_kind='debit' AND source_kind='usage' AND source_ref=$2 ORDER BY id",
              ["tenant", "corrupt-source"],
            );
            expect(matches.rows).toHaveLength(
              duplicate ? 2 : damage === "missing" ? 0 : 1,
            );
            if (damage === "duplicate-cross-account") {
              expect(matches.rows).toEqual(
                expect.arrayContaining([
                  { id: debit.id, account: account.accountId, amount: "-30" },
                  { id: injectedId, account: other.accountId, amount: "-31" },
                ]),
              );
            }
            const before = await terminalFacts();
            await expect(
              finish("capture", hold.holdId, "corrupt-source", 30n),
            ).rejects.toMatchObject({ code: "CREDIT_HOLD_TERMINAL_CORRUPT" });
            expect(await terminalFacts()).toEqual(before);
          } finally {
            if (duplicate) {
              await target.pool.query(
                "DELETE FROM billing_credit_journal WHERE id=$1::uuid",
                [injectedId],
              );
              await target.pool.query(
                "ALTER TABLE billing_credit_journal ADD CONSTRAINT uq_billing_credit_journal_source UNIQUE (tenant_id,source_kind,source_ref,entry_kind)",
              );
            }
          }
        },
      );

      test.each(["source-null", "amount-incomplete"] as const)(
        "T09 stored terminal %s corruption never re-executes the effect",
        async (damage) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "corrupt-terminal");
          await finish("capture", hold.holdId, "terminal-corrupt-source", 30n);
          expect(await terminalSource(hold.holdId)).toBe(
            "terminal-corrupt-source",
          );
          const pool = assertDefined(fixture).pool;
          const constraint =
            damage === "source-null"
              ? "ck_billing_credit_hold_terminal_source"
              : "ck_billing_credit_hold_terminal_amounts";
          const definitions = await pool.query<{ definition: string }>(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.billing_credit_hold'::regclass AND conname=$1",
            [constraint],
          );
          expect(definitions.rows).toHaveLength(1);
          const definition = assertDefined(definitions.rows[0]).definition;
          // Names are the fixed two-case allow-list above; definition is this
          // fixture's own original catalog, restored after the deliberate corruption.
          await pool.query(
            `ALTER TABLE billing_credit_hold DROP CONSTRAINT ${constraint}`,
          );
          try {
            await pool.query(
              damage === "source-null"
                ? "UPDATE billing_credit_hold SET terminal_source_ref=NULL WHERE id=$1::uuid"
                : "UPDATE billing_credit_hold SET released_micros=5 WHERE id=$1::uuid",
              [hold.holdId],
            );
            const before = await terminalFacts();
            await expect(
              finish("capture", hold.holdId, "terminal-corrupt-source", 30n),
            ).rejects.toMatchObject({ code: "CREDIT_HOLD_TERMINAL_CORRUPT" });
            expect(await terminalFacts()).toEqual(before);
          } finally {
            await pool.query(
              "UPDATE billing_credit_hold SET terminal_source_ref=$2,released_micros=10 WHERE id=$1::uuid",
              [hold.holdId, "terminal-corrupt-source"],
            );
            await pool.query(
              `ALTER TABLE billing_credit_hold ADD CONSTRAINT ${constraint} ${definition}`,
            );
          }
        },
      );

      test.each(
        (["capture", "release"] as const).flatMap((action) =>
          [
            { label: "empty", source: "" },
            { label: "256-codepoint", source: "😀".repeat(256) },
            { label: "nul", source: "\u0000" },
            { label: "unpaired-surrogate", source: "\ud800" },
          ].map((item) => ({ action, ...item })),
        ),
      )(
        "T09 $action rejects invalid opaque source $label with no persistent effect",
        async ({ action, source }) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "invalid-source");
          const before = await terminalFacts();
          await expect(
            finish(action, hold.holdId, source, 0n),
          ).rejects.toThrow();
          expect(await terminalFacts()).toEqual(before);
        },
      );
      test.each(
        (["capture", "release"] as const).flatMap((action) =>
          [
            { label: "255-non-BMP", source: "😀".repeat(255) },
            { label: "untrimmed", source: "  raw source  " },
            { label: "unnormalized", source: "e\u0301".repeat(127) + "e" },
          ].map((item) => ({ action, ...item })),
        ),
      )(
        "T09 $action preserves valid Unicode opaque source $label exactly",
        async ({ action, source }) => {
          const account = await grant();
          const hold = await holdFor(account.accountId, "valid-source");
          const result = await finish(action, hold.holdId, source, 0n);
          expect(await terminalSource(hold.holdId)).toBe(source);
          const before = await terminalFacts();
          await expect(
            finish(action, hold.holdId, source, 0n),
          ).resolves.toEqual(result);
          expect(await terminalFacts()).toEqual(before);
        },
      );

      test("T10 trusted tenant cannot finish another tenant hold", async () => {
        const account = await grant();
        const hold = await holdFor(account.accountId, "tenant-boundary");
        const before = await terminalFacts();
        await expect(
          finish(
            "capture",
            hold.holdId,
            "tenant-source",
            30n,
            { tx, effects },
            "foreign",
          ),
        ).rejects.toMatchObject({ code: "CREDIT_HOLD_NOT_ACTIVE" });
        expect(await terminalFacts()).toEqual(before);
      });
      test.each([
        "account-tenant",
        "grant-tenant",
        "grant-account",
        "allocation-tenant",
        "missing-grant",
        "missing-allocation",
      ] as const)(
        "T10 locks then rejects broken %s relationship without any mutation",
        async (damage) => {
          const account = await grant();
          const other = await otherGrant();
          const hold = await holdFor(account.accountId, "relation-corruption");
          const client = assertDefined(fixture).client;
          const allocation =
            await client.billing_credit_hold_allocation.findFirstOrThrow({
              where: { credit_hold_id: hold.holdId },
            });
          switch (damage) {
            case "account-tenant":
              await client.billing_credit_account.update({
                where: { id: account.accountId },
                data: { tenant_id: "foreign" },
              });
              break;
            case "grant-tenant":
              await client.billing_credit_grant.update({
                where: { id: account.grantId },
                data: { tenant_id: "foreign" },
              });
              break;
            case "grant-account":
              await client.billing_credit_grant.update({
                where: { id: account.grantId },
                data: { credit_account_id: other.accountId },
              });
              break;
            case "allocation-tenant":
              await client.billing_credit_hold_allocation.update({
                where: { id: allocation.id },
                data: { tenant_id: "foreign" },
              });
              break;
            case "missing-grant":
              await client.billing_credit_hold_allocation.update({
                where: { id: allocation.id },
                data: { credit_grant_id: randomUUID() },
              });
              break;
            case "missing-allocation":
              await client.billing_credit_hold_allocation.delete({
                where: { id: allocation.id },
              });
              break;
          }
          const before = await terminalFacts();
          await expect(
            finish("capture", hold.holdId, "relation-source", 30n),
          ).rejects.toMatchObject({ code: "CREDIT_HOLD_TERMINAL_CORRUPT" });
          expect(await terminalFacts()).toEqual(before);
        },
      );

      test("T10 account lock precedes grant and hold locks on the real contender", async () => {
        const account = await grant();
        const hold = await holdFor(account.accountId, "lock-order");
        const target = assertDefined(fixture);
        const blocker = await target.pool.connect();
        const peer = createPeer();
        let pending:
          Promise<PromiseSettledResult<HoldTerminalResult>[]> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM billing_credit_account WHERE id=$1::uuid FOR UPDATE",
            [account.accountId],
          );
          pending = Promise.allSettled([
            finish("capture", hold.holdId, "lock-source", 30n, peer),
          ]);
          let waiting: string[] = [];
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const rows = await target.pool.query<{ query: string }>(
              "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active' AND pid<>pg_backend_pid()",
            );
            waiting = rows.rows.map(({ query }) => query);
            if (
              waiting.some((query) => query.includes("billing_credit_account"))
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(
            waiting.some((query) => query.includes("billing_credit_account")),
          ).toBe(true);
          await blocker.query(
            "SELECT id FROM billing_credit_grant WHERE id=$1::uuid FOR UPDATE NOWAIT",
            [account.grantId],
          );
          await blocker.query(
            "SELECT id FROM billing_credit_hold WHERE id=$1::uuid FOR UPDATE NOWAIT",
            [hold.holdId],
          );
          await blocker.query("ROLLBACK");
          const results = await pending;
          expect(results[0]?.status).toBe("fulfilled");
          await assertFirstTerminal(
            hold.holdId,
            account.accountId,
            "capture",
            30n,
            "lock-source",
          );
        } finally {
          try {
            await blocker.query("ROLLBACK");
          } finally {
            blocker.release();
            if (pending) await pending;
            await peer.close();
          }
        }
      });

      test("T10 grant locks use id order independently of expiry burn order", async () => {
        const credits = [];
        for (const key of ["multi-a", "multi-b"]) {
          credits.push(
            await credit.grant({
              tenantId: "tenant",
              actorId: "operator",
              subjectId: "multi-grant",
              amountMicros: 20n,
              sourceKind: "admin",
              sourceRef: key,
              programKey: "program",
              effectiveAt: new Date("2026-01-01T00:00:00Z"),
              idempotencyKey: key,
            }),
          );
        }
        const sorted = credits.sort((a, b) =>
          a.grantId.localeCompare(b.grantId),
        );
        const low = assertDefined(sorted[0]);
        const high = assertDefined(sorted[1]);
        const target = assertDefined(fixture);
        // Burn high-id grant first, but lock low-id grant first.
        await target.client.billing_credit_grant.update({
          where: { id: high.grantId },
          data: { expires_at: new Date("2040-01-01T00:00:00Z") },
        });
        await target.client.billing_credit_grant.update({
          where: { id: low.grantId },
          data: { expires_at: new Date("2050-01-01T00:00:00Z") },
        });
        const hold = await holdFor(low.accountId, "multi-grant-hold");
        const blocker = await target.pool.connect();
        const peer = createPeer();
        let pending:
          Promise<PromiseSettledResult<HoldTerminalResult>[]> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM billing_credit_grant WHERE id=$1::uuid FOR UPDATE",
            [high.grantId],
          );
          pending = Promise.allSettled([
            finish("capture", hold.holdId, "multi-grant-source", 30n, peer),
          ]);
          let waiting = false;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const rows = await target.pool.query<{ query: string }>(
              "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active' AND pid<>pg_backend_pid()",
            );
            waiting = rows.rows.some(({ query }) =>
              query.includes("billing_credit_grant"),
            );
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(waiting).toBe(true);
          // A NOWAIT failure proves the contender owns low-id while waiting
          // for high-id; a burn-order lock would leave low-id unlocked.
          await expect(
            blocker.query(
              "SELECT id FROM billing_credit_grant WHERE id=$1::uuid FOR UPDATE NOWAIT",
              [low.grantId],
            ),
          ).rejects.toMatchObject({ code: "55P03" });
          await blocker.query("ROLLBACK");
          const results = await pending;
          expect(results[0]).toMatchObject({
            status: "fulfilled",
            value: {
              holdId: hold.holdId,
              accountId: low.accountId,
              capturedMicros: 30n,
              releasedMicros: 10n,
            },
          });
          const allocations =
            await target.client.billing_credit_hold_allocation.findMany({
              where: { credit_hold_id: hold.holdId },
              orderBy: { credit_grant_id: "asc" },
            });
          expect(allocations).toHaveLength(2);
          expect(allocations[0]).toMatchObject({
            credit_grant_id: low.grantId,
            held_micros: 20n,
            captured_micros: 10n,
            released_micros: 10n,
          });
          expect(allocations[1]).toMatchObject({
            credit_grant_id: high.grantId,
            held_micros: 20n,
            captured_micros: 20n,
            released_micros: 0n,
          });
          expect(
            await target.client.billing_credit_account.findUniqueOrThrow({
              where: { id: low.accountId },
            }),
          ).toMatchObject({
            available_micros: 10n,
            held_micros: 0n,
            generation: 5n,
          });
          expect(await terminalSource(hold.holdId)).toBe("multi-grant-source");
        } finally {
          try {
            await blocker.query("ROLLBACK");
          } finally {
            blocker.release();
            if (pending) await pending;
            await peer.close();
          }
        }
      });

      test("T10 independent accounts finish concurrently without cross-account debit or projection", async () => {
        const a = await grant();
        const b = await otherGrant();
        const ha = await holdFor(a.accountId, "independent-a");
        const hb = await holdFor(b.accountId, "independent-b");
        const peer = createPeer();
        try {
          const results = await Promise.allSettled([
            finish("capture", ha.holdId, "independent-source-a", 30n),
            finish("capture", hb.holdId, "independent-source-b", 20n, peer),
          ]);
          expect(results.map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          await assertFirstTerminal(
            ha.holdId,
            a.accountId,
            "capture",
            30n,
            "independent-source-a",
          );
          await assertFirstTerminal(
            hb.holdId,
            b.accountId,
            "capture",
            20n,
            "independent-source-b",
          );
          for (const [account, amount] of [
            [a, 30n],
            [b, 20n],
          ] as const) {
            expect(
              await assertDefined(
                fixture,
              ).client.billing_credit_account.findUniqueOrThrow({
                where: { id: account.accountId },
              }),
            ).toMatchObject({
              available_micros: 100n - amount,
              held_micros: 0n,
              generation: 4n,
            });
            expect(
              await assertDefined(
                fixture,
              ).client.billing_credit_grant.findUniqueOrThrow({
                where: { id: account.grantId },
              }),
            ).toMatchObject({ remaining_micros: 100n - amount });
          }
        } finally {
          await peer.close();
        }
      });
    });

    test("reserve identity replay permanently binds another key without repeating the effect", async () => {
      const account = await grant();
      const input = {
        tenantId: "tenant",
        actorId: "service",
        accountId: account.accountId,
        requestedMicros: 40n,
        featureKey: "chat",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        commandIdentity: "reserve-identity",
        idempotencyKey: "reserve-key-1",
      } as const;
      const first = await credit.reserve(input);
      const beforeReplay = await reserveFacts();
      expect(
        await credit.reserve({ ...input, idempotencyKey: "reserve-key-2" }),
      ).toEqual(first);
      const afterReplay = await reserveFacts();
      expect({ ...afterReplay, bindings: beforeReplay.bindings }).toEqual(
        beforeReplay,
      );
      expect(
        afterReplay.bindings.filter(
          (binding) => binding.idempotency_key !== "reserve-key-2",
        ),
      ).toEqual(beforeReplay.bindings);
      const reserveBindings = afterReplay.bindings.filter(
        (binding) => binding.command_name === "credit.reserve",
      );
      expect(
        reserveBindings.map((binding) => binding.idempotency_key).sort(),
      ).toEqual(["reserve-key-1", "reserve-key-2"]);
      const receipt = assertDefined(
        afterReplay.receipts.find(
          (item) => item.command_name === "credit.reserve",
        ),
      );
      expect(
        reserveBindings.every(
          (binding) => binding.command_receipt_id === receipt.id,
        ),
      ).toBe(true);
      expect(receipt).toMatchObject({
        status: "succeeded",
        command_identity: input.commandIdentity,
      });
      expect(afterReplay.holds).toHaveLength(1);
      expect(afterReplay.accounts[0]).toMatchObject({
        available_micros: 60n,
        held_micros: 40n,
      });
      expect(await credit.reserve(input)).toEqual(first);
      expect(
        await credit.reserve({ ...input, idempotencyKey: "reserve-key-2" }),
      ).toEqual(first);
      expect(await reserveFacts()).toEqual(afterReplay);
      await expect(
        credit.reserve({
          ...input,
          idempotencyKey: "reserve-key-2",
          commandIdentity: "another-identity",
        }),
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
      expect(await reserveFacts()).toEqual(afterReplay);
    });

    test.each(
      (["same-key", "new-key"] as const).flatMap((keyMode) =>
        (["amount", "account", "feature", "expiry"] as const).map((field) => ({
          keyMode,
          field,
        })),
      ),
    )(
      "reserve $keyMode rejects $field drift without changing durable facts",
      async ({ keyMode, field }) => {
        const account = await grant();
        const otherAccount = await credit.grant({
          tenantId: "tenant",
          actorId: "operator",
          subjectId: "other-subject",
          amountMicros: 100n,
          sourceKind: "admin",
          sourceRef: "other-source",
          programKey: "program",
          effectiveAt: new Date("2026-01-01T00:00:00Z"),
          idempotencyKey: "other-grant-key",
        });
        const input = {
          tenantId: "tenant",
          actorId: "service",
          accountId: account.accountId,
          requestedMicros: 40n,
          featureKey: "chat",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          commandIdentity: "reserve-drift-identity",
          idempotencyKey: "reserve-drift-key-1",
        } as const;
        await credit.reserve(input);
        const before = await reserveFacts();
        const drift = {
          amount: { requestedMicros: 41n },
          account: { accountId: otherAccount.accountId },
          feature: { featureKey: "other-feature" },
          expiry: { expiresAt: new Date("2099-02-01T00:00:00Z") },
        }[field];
        await expect(
          credit.reserve({
            ...input,
            ...drift,
            idempotencyKey:
              keyMode === "same-key"
                ? input.idempotencyKey
                : "reserve-drift-key-2",
          }),
        ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
        expect(await reserveFacts()).toEqual(before);
      },
    );

    test("concurrent reserve identity requests with different keys commit one effect and both bindings", async () => {
      const account = await grant();
      const input = {
        tenantId: "tenant",
        actorId: "service",
        accountId: account.accountId,
        requestedMicros: 40n,
        featureKey: "chat",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        commandIdentity: "concurrent-reserve-identity",
      } as const;
      const [first, second] = await Promise.allSettled([
        credit.reserve({ ...input, idempotencyKey: "concurrent-key-1" }),
        credit.reserve({ ...input, idempotencyKey: "concurrent-key-2" }),
      ]);
      expect([first.status, second.status]).toEqual(["fulfilled", "fulfilled"]);
      if (first.status !== "fulfilled" || second.status !== "fulfilled")
        throw new Error("Both reserve identity requests must succeed");
      expect(second.value).toEqual(first.value);
      const facts = await reserveFacts();
      expect(facts.accounts[0]).toMatchObject({
        available_micros: 60n,
        held_micros: 40n,
        generation: 3n,
      });
      expect(facts.holds).toHaveLength(1);
      expect(facts.allocations).toHaveLength(1);
      expect(facts.allocations[0]).toMatchObject({
        credit_hold_id: first.value.holdId,
        held_micros: 40n,
      });
      expect(facts.journals).toHaveLength(1);
      const reserveReceipts = facts.receipts.filter(
        (item) => item.command_name === "credit.reserve",
      );
      expect(reserveReceipts).toHaveLength(1);
      const reserveReceipt = assertDefined(reserveReceipts[0]);
      const reserveBindings = facts.bindings.filter(
        (item) => item.command_name === "credit.reserve",
      );
      expect(
        reserveBindings.map((item) => item.idempotency_key).sort(),
      ).toEqual(["concurrent-key-1", "concurrent-key-2"]);
      expect(
        reserveBindings.every(
          (item) => item.command_receipt_id === reserveReceipt.id,
        ),
      ).toBe(true);
      const reserveAudits = facts.audits.filter(
        (item) => item.action === "credit.reserve",
      );
      expect(reserveAudits).toHaveLength(1);
      expect(reserveAudits[0]).toMatchObject({
        resource_id: first.value.holdId,
      });
    });

    test("reserve audit tail failure rolls back the hold, balance, receipt and key binding", async () => {
      const account = await grant();
      const before = await reserveFacts();
      class FailingReserveAudit extends AuditAppender {
        attempts = 0;
        override async append(input: AuditAppendInput): Promise<string> {
          await super.append(input);
          this.attempts += 1;
          throw new Error("reserve audit tail");
        }
      }
      const audit = new FailingReserveAudit(tx);
      const failing = new CreditService(
        tx,
        new CommandReceiptRepository(tx),
        new CreditEffects(tx, new CreditRepository(tx), audit),
      );
      const input = {
        tenantId: "tenant",
        actorId: "service",
        accountId: account.accountId,
        requestedMicros: 40n,
        featureKey: "chat",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        commandIdentity: "rollback-reserve-identity",
        idempotencyKey: "rollback-reserve-key",
      } as const;
      await expect(failing.reserve(input)).rejects.toThrow(
        "reserve audit tail",
      );
      expect(audit.attempts).toBe(1);
      expect(await reserveFacts()).toEqual(before);
      await expect(credit.reserve(input)).resolves.toMatchObject({
        requestedMicros: 40n,
      });
      const afterRetry = await reserveFacts();
      expect(afterRetry.accounts[0]).toMatchObject({
        available_micros: 60n,
        held_micros: 40n,
        generation: 3n,
      });
      expect(afterRetry.holds).toHaveLength(1);
      expect(afterRetry.allocations).toHaveLength(1);
      expect(afterRetry.receipts).toHaveLength(before.receipts.length + 1);
      expect(afterRetry.bindings).toHaveLength(before.bindings.length + 1);
      expect(afterRetry.audits).toHaveLength(before.audits.length + 1);
    });

    test("grants, permanently replays another key, reserves and captures bigint credit", async () => {
      const first = await grant();
      expect(await grant("grant-2")).toEqual(first);
      const hold = await credit.reserve({
        tenantId: "tenant",
        actorId: "service",
        accountId: first.accountId,
        requestedMicros: 40n,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "hold-1",
        commandIdentity: "hold-identity",
      });
      await tx.runRoot(
        {
          tenantId: "tenant",
          actorId: "service",
          operation: "capture",
          mode: "write",
        },
        () =>
          effects.capture({
            tenantId: "tenant",
            holdId: hold.holdId,
            actualMicros: 40n,
            sourceRef: "usage-1",
          }),
      );
      const account = await assertDefined(
        fixture,
      ).client.billing_credit_account.findUniqueOrThrow({
        where: { id: first.accountId },
      });
      expect(account).toMatchObject({ available_micros: 60n, held_micros: 0n });
      expect(
        await assertDefined(fixture).client.billing_command_key_binding.count(),
      ).toBe(3);
    });

    test("allows only one concurrent reservation when funds are insufficient", async () => {
      const account = await grant();
      const reserve = (key: string) =>
        credit.reserve({
          tenantId: "tenant",
          actorId: key,
          accountId: account.accountId,
          requestedMicros: 70n,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: key,
        });
      const results = await Promise.allSettled([
        reserve("reserve-a"),
        reserve("reserve-b"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        await assertDefined(fixture).client.billing_credit_hold.count(),
      ).toBe(1);
    });

    test("settles usage and Credit mutations in one transaction", async () => {
      const account = await grant();
      const hold = await credit.reserve({
        tenantId: "tenant",
        actorId: "svc",
        accountId: account.accountId,
        requestedMicros: 30n,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "usage-hold",
      });
      const metering = new MeteringService(
        tx,
        new MeteringRepository(tx),
        effects,
      );
      const settled = await metering.settle({
        tenantId: "tenant",
        actorId: "svc",
        holdId: hold.holdId,
        sourceEventId: "event-1",
        subjectId: "subject",
        featureKey: "tokens",
        quantity: 1n,
        actualMicros: 20n,
      });
      expect(settled).toMatchObject({
        capturedMicros: 20n,
        releasedMicros: 10n,
      });
      expect(
        await assertDefined(fixture).client.billing_usage_settlement.count(),
      ).toBe(1);
    });

    test("rolls back grant and receipt when a nested caller fails", async () => {
      await expect(
        tx.runRoot(
          {
            tenantId: "tenant",
            actorId: "operator",
            operation: "outer",
            mode: "write",
          },
          async () => {
            await effects.grant({
              tenantId: "tenant",
              subjectId: "subject",
              amountMicros: 100n,
              sourceKind: "admin",
              sourceRef: "rollback",
              programKey: "program",
              effectiveAt: new Date("2026-01-01T00:00:00Z"),
            });
            throw new Error("tail failed");
          },
        ),
      ).rejects.toThrow("tail failed");
      expect(
        await assertDefined(fixture).client.billing_credit_grant.count(),
      ).toBe(0);
      expect(
        await assertDefined(fixture).client.billing_credit_journal.count(),
      ).toBe(0);
    });
    test("assembles Credit and Metering over one global transaction owner", async () => {
      const target = assertDefined(fixture);
      const context = await Test.createTestingModule({
        imports: [
          DatabaseModule.register({
            databaseUrl: target.url,
            pool: { max: 2 },
          }),
          CreditModule,
          MeteringModule,
        ],
      }).compile();
      try {
        await context.init();
        const owner = context.get(TransactionService);
        expect(context.get(TransactionService)).toBe(owner);
        const moduleCredit = context.get(CreditService);
        const moduleMetering = context.get(MeteringService);
        const account = await moduleCredit.grant({
          tenantId: "module-tenant",
          actorId: "operator",
          subjectId: "subject",
          amountMicros: 30n,
          sourceKind: "admin",
          sourceRef: "module-grant",
          programKey: "program",
          effectiveAt: new Date("2026-01-01T00:00:00Z"),
          idempotencyKey: "module-grant",
        });
        const hold = await moduleCredit.reserve({
          tenantId: "module-tenant",
          actorId: "svc",
          accountId: account.accountId,
          requestedMicros: 20n,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: "module-hold",
        });
        await expect(
          moduleMetering.settle({
            tenantId: "module-tenant",
            actorId: "svc",
            holdId: hold.holdId,
            sourceEventId: "module-event",
            subjectId: "subject",
            featureKey: "tokens",
            quantity: 1n,
            actualMicros: 20n,
          }),
        ).resolves.toMatchObject({ capturedMicros: 20n });
      } finally {
        await context.close();
      }
    });

    test("computes command digest internally and rejects payload drift", async () => {
      await grant("digest-key-1");
      await expect(
        credit.grant({
          tenantId: "tenant",
          actorId: "operator",
          subjectId: "subject",
          amountMicros: 101n,
          sourceKind: "admin",
          sourceRef: "source-1",
          programKey: "program",
          effectiveAt: new Date("2026-01-01T00:00:00Z"),
          idempotencyKey: "digest-key-2",
          commandIdentity: "grant-identity",
        }),
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
    });

    test("does not expose a future grant until its effective window", async () => {
      const effectiveAt = new Date(Date.now() + 100);
      const result = await credit.grant({
        tenantId: "tenant",
        actorId: "operator",
        subjectId: "future-subject",
        amountMicros: 25n,
        sourceKind: "admin",
        sourceRef: "future-source",
        programKey: "program",
        effectiveAt,
        idempotencyKey: "future-grant",
      });
      expect(
        (await credit.getAccount("tenant", result.accountId))?.availableMicros,
      ).toBe(0n);
      await new Promise((resolve) => setTimeout(resolve, 125));
      await tx.runRoot(
        {
          tenantId: "tenant",
          actorId: "expiry",
          operation: "credit.refresh_windows",
          mode: "write",
        },
        () => effects.refreshGrantWindows("tenant", result.accountId),
      );
      await expect(
        credit.reserve({
          tenantId: "tenant",
          actorId: "svc",
          accountId: result.accountId,
          requestedMicros: 25n,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: "future-hold",
        }),
      ).resolves.toMatchObject({ requestedMicros: 25n });
    });

    test("serializes capture and release into one terminal result", async () => {
      const account = await grant();
      const hold = await credit.reserve({
        tenantId: "tenant",
        actorId: "svc",
        accountId: account.accountId,
        requestedMicros: 40n,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "terminal-hold",
      });
      const scope = (operation: string) => ({
        tenantId: "tenant",
        actorId: operation,
        operation,
        mode: "write" as const,
      });
      const results = await Promise.allSettled([
        tx.runRoot(scope("capture"), () =>
          effects.capture({
            tenantId: "tenant",
            holdId: hold.holdId,
            actualMicros: 30n,
            sourceRef: "terminal-event",
          }),
        ),
        tx.runRoot(scope("release"), () =>
          effects.release({
            tenantId: "tenant",
            holdId: hold.holdId,
            sourceRef: "cancel",
          }),
        ),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.filter((item) => item.status === "rejected")).toHaveLength(
        1,
      );
      expect(["captured", "released"]).toContain(
        (
          await assertDefined(
            fixture,
          ).client.billing_credit_hold.findUniqueOrThrow({
            where: { id: hold.holdId },
          })
        ).status,
      );
    });

    test("rolls back receipt, credit and audit when the audit tail fails", async () => {
      const repository = new CreditRepository(tx);
      class FailingAudit extends AuditAppender {
        override append(): Promise<string> {
          return Promise.reject(new Error("audit tail"));
        }
      }
      const failingEffects = new CreditEffects(
        tx,
        repository,
        new FailingAudit(tx),
      );
      const service = new CreditService(
        tx,
        new CommandReceiptRepository(tx),
        failingEffects,
      );
      await expect(
        service.grant({
          tenantId: "tenant",
          actorId: "operator",
          subjectId: "subject",
          amountMicros: 20n,
          sourceKind: "admin",
          sourceRef: "tail-source",
          programKey: "program",
          effectiveAt: new Date("2026-01-01T00:00:00Z"),
          idempotencyKey: "tail-key",
        }),
      ).rejects.toThrow("audit tail");
      expect(
        await assertDefined(fixture).client.billing_credit_grant.count(),
      ).toBe(0);
      expect(
        await assertDefined(fixture).client.billing_command_receipt.count(),
      ).toBe(0);
      expect(
        await assertDefined(fixture).client.billing_audit_event.count(),
      ).toBe(0);
    });

    test("rejects grant source reuse with another program", async () => {
      await grant("source-key-1");
      await expect(
        credit.grant({
          tenantId: "tenant",
          actorId: "operator",
          subjectId: "subject",
          amountMicros: 100n,
          sourceKind: "admin",
          sourceRef: "source-1",
          programKey: "other-program",
          effectiveAt: new Date("2026-01-01T00:00:00Z"),
          idempotencyKey: "source-key-2",
        }),
      ).rejects.toMatchObject({ code: "CREDIT_IDEMPOTENCY_CONFLICT" });
      expect(
        await assertDefined(fixture).client.billing_credit_grant.count(),
      ).toBe(1);
    });

    test("expires active grant availability before another reservation", async () => {
      const result = await credit.grant({
        tenantId: "tenant",
        actorId: "operator",
        subjectId: "expiring",
        amountMicros: 15n,
        sourceKind: "admin",
        sourceRef: "expiring-source",
        programKey: "program",
        effectiveAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date(Date.now() + 100),
        idempotencyKey: "expiring-grant",
      });
      await new Promise((resolve) => setTimeout(resolve, 125));
      await tx.runRoot(
        {
          tenantId: "tenant",
          actorId: "expiry",
          operation: "credit.refresh_windows",
          mode: "write",
        },
        () => effects.refreshGrantWindows("tenant", result.accountId),
      );
      await expect(
        credit.reserve({
          tenantId: "tenant",
          actorId: "svc",
          accountId: result.accountId,
          requestedMicros: 1n,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: "expired-hold",
        }),
      ).rejects.toMatchObject({ code: "CREDIT_INSUFFICIENT" });
      const account = await credit.getAccount("tenant", result.accountId);
      expect(account?.availableMicros).toBe(0n);
    });

    test("rejects usage replay when dimensions or amount drift", async () => {
      const account = await grant();
      const hold = await credit.reserve({
        tenantId: "tenant",
        actorId: "svc",
        accountId: account.accountId,
        requestedMicros: 20n,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "drift-hold",
      });
      const metering = new MeteringService(
        tx,
        new MeteringRepository(tx),
        effects,
      );
      const base = {
        tenantId: "tenant",
        actorId: "svc",
        holdId: hold.holdId,
        sourceEventId: "drift-event",
        subjectId: "subject",
        featureKey: "tokens",
        quantity: 1n,
        actualMicros: 10n,
        dimensions: { model: "a" },
      } as const;
      await metering.settle(base);
      await expect(
        metering.settle({ ...base, dimensions: { model: "b" } }),
      ).rejects.toMatchObject({ code: "USAGE_EVENT_MISMATCH" });
      await expect(
        metering.settle({ ...base, actualMicros: 11n }),
      ).rejects.toMatchObject({ code: "CREDIT_IDEMPOTENCY_CONFLICT" });
      expect(
        await assertDefined(fixture).client.billing_usage_settlement.count(),
      ).toBe(1);
    });

    test("marks the whole effect transaction rollback-only when its error is caught", async () => {
      await expect(
        tx.runRoot(
          {
            tenantId: "tenant",
            actorId: "operator",
            operation: "caught-effect",
            mode: "write",
          },
          async () => {
            const granted = await effects.grant({
              tenantId: "tenant",
              subjectId: "subject",
              amountMicros: 10n,
              sourceKind: "admin",
              sourceRef: "caught-source",
              programKey: "program",
              effectiveAt: new Date("2026-01-01T00:00:00Z"),
            });
            try {
              await effects.reserve({
                tenantId: "tenant",
                accountId: granted.accountId,
                idempotencyKey: "too-large",
                requestedMicros: 20n,
                expiresAt: new Date(Date.now() + 60_000),
              });
            } catch {
              /* rollback-only is asserted by the outer result */
            }
          },
        ),
      ).rejects.toMatchObject({ code: "CREDIT_INSUFFICIENT" });
      expect(
        await assertDefined(fixture).client.billing_credit_grant.count(),
      ).toBe(0);
      expect(
        await assertDefined(fixture).client.billing_audit_event.count(),
      ).toBe(0);
    });
  },
);
