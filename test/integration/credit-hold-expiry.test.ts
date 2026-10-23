import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { CreditRepository } from "../../src/modules/credit/credit.repository.js";
import {
  CreditEffects,
  CreditService,
} from "../../src/modules/credit/credit.service.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const admin = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(!admin)("model hold across grant expiry", () => {
  let db: PrismaDatabaseFixture;
  let tx: TransactionService;
  let repository: CreditRepository;
  let audit: AuditAppender;
  let effects: CreditEffects;
  let credit: CreditService;
  const scope = {
    tenantId: "tenant",
    actorId: "settler",
    operation: "credit.settle",
    mode: "write" as const,
  };
  beforeEach(async () => {
    db = await createPrismaDatabaseFixture(assertDefined(admin));
    tx = new TransactionService(db.client);
    repository = new CreditRepository(tx);
    audit = new AuditAppender(tx);
    effects = new CreditEffects(tx, repository, audit);
    credit = new CreditService(
      tx,
      new CommandReceiptRepository(tx),
      effects,
      repository,
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });
  const grant = (key: string, amountMicros = 100n) =>
    credit.grant({
      tenantId: "tenant",
      actorId: "operator",
      subjectId: "user",
      amountMicros,
      sourceKind: "admin",
      sourceRef: key,
      programKey: "qa",
      reason: "isolated model settlement",
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      ...(key === "expiring"
        ? { expiresAt: new Date("2099-01-01T00:00:00.000Z") }
        : {}),
      idempotencyKey: "grant-" + key,
    });
  const reserve = (accountId: string, requestedMicros = 40n) =>
    credit.reserve({
      tenantId: "tenant",
      actorId: "settler",
      accountId,
      requestedMicros,
      featureKey: "chat",
      expiresAt: null,
      idempotencyKey: "model-hold",
    });
  const expire = (grantId: string) => db.client.$executeRaw`
    UPDATE billing_credit_grant SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${grantId}::uuid`;
  const refresh = (accountId: string) =>
    tx.runRoot(scope, () =>
      repository.refreshGrantWindows("tenant", accountId),
    );
  const finish = (holdId: string, actual: bigint) =>
    tx.runRoot(scope, () =>
      actual === 0n
        ? effects.release({
            tenantId: "tenant",
            holdId,
            sourceRef: "model-outcome",
          })
        : effects.capture({
            tenantId: "tenant",
            holdId,
            sourceRef: "model-outcome",
            actualMicros: actual,
          }),
    );
  const facts = async () => {
    const tables = [
      "billing_credit_account",
      "billing_credit_grant",
      "billing_credit_hold",
      "billing_credit_hold_allocation",
      "billing_credit_journal",
      "billing_audit_event",
    ];
    return Promise.all(
      tables.map(async (table) =>
        (
          await db.pool.query<{ fact: string }>(
            `SELECT row_to_json(t)::text AS fact FROM ${table} t ORDER BY id`,
          )
        ).rows.map((row) => row.fact),
      ),
    );
  };

  test.each(
    [false, true].flatMap((refreshed) =>
      [0n, 30n, 40n].map((actual) => ({ refreshed, actual })),
    ),
  )(
    "expired allocation never becomes spendable: refreshed=$refreshed actual=$actual",
    async ({ refreshed, actual }) => {
      const funded = await grant("expiring");
      const hold = await reserve(funded.accountId);
      await expire(funded.grantId);
      if (refreshed) await refresh(funded.accountId);
      const result = await finish(hold.holdId, actual);
      expect(result).toMatchObject({
        capturedMicros: actual,
        releasedMicros: 40n - actual,
      });
      expect(
        await db.client.billing_credit_account.findUnique({
          where: { id: funded.accountId },
        }),
      ).toMatchObject({ available_micros: 0n, held_micros: 0n });
      expect(
        await db.client.billing_credit_grant.findUnique({
          where: { id: funded.grantId },
        }),
      ).toMatchObject({ status: "expired", remaining_micros: 0n });
      const journals = await db.client.billing_credit_journal.findMany({
        where: { tenant_id: "tenant" },
      });
      expect(
        journals.reduce((total, row) => total + row.amount_micros, 0n),
      ).toBe(0n);
      expect(
        journals
          .filter((row) => row.entry_kind === "expiry")
          .reduce((total, row) => total + row.amount_micros, 0n),
      ).toBe(-(100n - actual));
      const before = await facts();
      await finish(hold.holdId, actual);
      await refresh(funded.accountId);
      expect(await facts()).toEqual(before);
    },
  );

  test.each(["active", "disabled"])(
    "valid allocation release preserves %s account",
    async (status) => {
      const funded = await grant("permanent");
      const hold = await reserve(funded.accountId);
      await db.client.billing_credit_account.update({
        where: { id: funded.accountId },
        data: { status },
      });
      await finish(hold.holdId, 30n);
      expect(
        await db.client.billing_credit_account.findUnique({
          where: { id: funded.accountId },
        }),
      ).toMatchObject({ status, available_micros: 70n, held_micros: 0n });
      expect(
        await db.client.billing_credit_grant.findUnique({
          where: { id: funded.grantId },
        }),
      ).toMatchObject({ remaining_micros: 70n });
    },
  );

  test("mixed allocations retire only expired unused credit", async () => {
    const expired = await grant("expiring", 30n);
    const valid = await grant("permanent");
    const hold = await reserve(expired.accountId, 50n);
    await expire(expired.grantId);
    await finish(hold.holdId, 10n);
    expect(
      await db.client.billing_credit_account.findUnique({
        where: { id: expired.accountId },
      }),
    ).toMatchObject({ available_micros: 100n, held_micros: 0n });
    expect(
      await db.client.billing_credit_grant.findUnique({
        where: { id: expired.grantId },
      }),
    ).toMatchObject({ remaining_micros: 0n });
    expect(
      await db.client.billing_credit_grant.findUnique({
        where: { id: valid.grantId },
      }),
    ).toMatchObject({ remaining_micros: 100n });
  });

  test("refresh and duplicate completion serialize without resurrecting funds", async () => {
    const funded = await grant("expiring");
    const hold = await reserve(funded.accountId);
    await expire(funded.grantId);
    await Promise.all([
      refresh(funded.accountId),
      finish(hold.holdId, 30n),
      finish(hold.holdId, 30n),
    ]);
    expect(
      await db.client.billing_credit_account.findUnique({
        where: { id: funded.accountId },
      }),
    ).toMatchObject({ available_micros: 0n, held_micros: 0n });
    expect(
      await db.client.billing_credit_journal.count({
        where: { entry_kind: "debit" },
      }),
    ).toBe(1);
    expect(
      await db.client.billing_audit_event.count({
        where: { action: "credit.capture" },
      }),
    ).toBe(1);
  });

  test("audit failure rolls expiry, capture and hold projection back together", async () => {
    const funded = await grant("expiring");
    const hold = await reserve(funded.accountId);
    await expire(funded.grantId);
    const before = await facts();
    vi.spyOn(audit, "append").mockRejectedValueOnce(
      new Error("isolated audit failure"),
    );
    await expect(finish(hold.holdId, 30n)).rejects.toThrow(
      "isolated audit failure",
    );
    expect(await facts()).toEqual(before);
    await finish(hold.holdId, 30n);
    expect(
      await db.client.billing_credit_account.findUnique({
        where: { id: funded.accountId },
      }),
    ).toMatchObject({ available_micros: 0n, held_micros: 0n });
  });
  test("expiry never repairs a corrupted held grant", async () => {
    const funded = await grant("expiring");
    const hold = await reserve(funded.accountId);
    await expire(funded.grantId);
    await db.client.billing_credit_grant.update({
      where: { id: funded.grantId },
      data: { remaining_micros: 20n },
    });
    const before = await facts();
    await expect(finish(hold.holdId, 30n)).rejects.toMatchObject({
      code: "CREDIT_HOLD_TERMINAL_CORRUPT",
    });
    expect(await facts()).toEqual(before);
  });
  test.each(
    ["terminal", "refresh"].flatMap((action) =>
      [false, true].map((refreshed) => ({ action, refreshed })),
    ),
  )(
    "all outstanding allocations must fit their grant: action=$action refreshed=$refreshed",
    async ({ action, refreshed }) => {
      const funded = await grant("expiring");
      const first = await reserve(funded.accountId);
      await credit.reserve({
        tenantId: "tenant",
        actorId: "settler",
        accountId: funded.accountId,
        requestedMicros: 40n,
        expiresAt: null,
        idempotencyKey: "second-model-hold",
      });
      await expire(funded.grantId);
      if (refreshed) await refresh(funded.accountId);
      await db.client.billing_credit_grant.update({
        where: { id: funded.grantId },
        data: { remaining_micros: 60n },
      });
      const before = await facts();
      await expect(
        action === "terminal"
          ? finish(first.holdId, 30n)
          : refresh(funded.accountId),
      ).rejects.toMatchObject({ code: "CREDIT_HOLD_TERMINAL_CORRUPT" });
      expect(await facts()).toEqual(before);
    },
  );

  test("finishing one expired hold preserves the other hold allocation", async () => {
    const funded = await grant("expiring");
    const first = await reserve(funded.accountId);
    const second = await credit.reserve({
      tenantId: "tenant",
      actorId: "settler",
      accountId: funded.accountId,
      requestedMicros: 40n,
      expiresAt: null,
      idempotencyKey: "second-model-hold",
    });
    await expire(funded.grantId);
    await finish(first.holdId, 30n);
    expect(
      await db.client.billing_credit_account.findUnique({
        where: { id: funded.accountId },
      }),
    ).toMatchObject({ available_micros: 0n, held_micros: 40n });
    expect(
      await db.client.billing_credit_grant.findUnique({
        where: { id: funded.grantId },
      }),
    ).toMatchObject({ remaining_micros: 40n });
    await tx.runRoot(scope, () =>
      effects.capture({
        tenantId: "tenant",
        holdId: second.holdId,
        sourceRef: "second-outcome",
        actualMicros: 20n,
      }),
    );
    expect(
      await db.client.billing_credit_account.findUnique({
        where: { id: funded.accountId },
      }),
    ).toMatchObject({ available_micros: 0n, held_micros: 0n });
    expect(
      await db.client.billing_credit_grant.findUnique({
        where: { id: funded.grantId },
      }),
    ).toMatchObject({ remaining_micros: 0n });
    expect(
      (await db.client.billing_credit_journal.findMany()).reduce(
        (sum, row) => sum + row.amount_micros,
        0n,
      ),
    ).toBe(0n);
  });
});
