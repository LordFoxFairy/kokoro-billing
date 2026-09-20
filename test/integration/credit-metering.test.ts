import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditAppender } from "../../src/database/audit-appender.js";
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
