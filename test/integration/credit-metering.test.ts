import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditAppender } from "../../src/database/audit-appender.js";
import type { AuditAppendInput } from "../../src/database/audit.types.js";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { DatabaseModule } from "../../src/database/database.module.js";
import { CreditModule } from "../../src/modules/credit/credit.module.js";
import { CreditRepository } from "../../src/modules/credit/credit.repository.js";
import {
  CreditEffects,
  CreditService,
} from "../../src/modules/credit/credit.service.js";
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
