import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CreditEffects,
  CreditError,
  CreditService,
} from "../../src/modules/credit/credit.public.js";
import type { CreditAccountSnapshot } from "../../src/modules/credit/credit.public.js";
import { CreditRepository } from "../../src/modules/credit/credit.repository.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import type { TransactionOptions } from "../../src/database/transaction.types.js";
import { assertDefined } from "../assert-defined.js";
import { createPrismaDatabaseFixture } from "./prisma-database.fixture.js";
import type { PrismaDatabaseFixture } from "./prisma-database.fixture.js";

// This is a test expectation, not a second production DTO or read implementation.
type ReadContext = Readonly<{ tenantId: string; subjectId: string }>;
type PageInput = Readonly<{ limit?: number; cursor?: string }>;
type LedgerItem = Readonly<{
  journalId: string;
  sequence: bigint;
  deltaMicros: bigint;
  balanceAfterMicros: bigint;
  sourceKind: string;
  sourceRef: string;
  createdAt: Date;
}>;
type LedgerPage = Readonly<{
  items: readonly LedgerItem[];
  nextCursor: string | null;
}>;
type CreditReadApi = {
  getMyAccount: (context: ReadContext) => Promise<CreditAccountSnapshot | null>;
  listMyLedger: (context: ReadContext, page: PageInput) => Promise<LedgerPage>;
};

// The current three-argument constructor is structurally assignable. The test
// always passes the fourth repository explicitly, ready for mandatory GREEN DI.
type CreditReadConstructor = new (
  transactions: TransactionService,
  receipts: CommandReceiptRepository,
  effects: CreditEffects,
  repository: CreditRepository,
) => CreditService;
const CreditWithReadRepository: CreditReadConstructor = CreditService;

function requireReadMethod<Args extends unknown[], Result>(
  service: CreditService,
  key: keyof CreditReadApi,
): (...args: Args) => Promise<Result> {
  const candidate: unknown = Reflect.get(service, key);
  expect(
    candidate,
    `capability precondition: ${key}; business assertion not reached`,
  ).toBeTypeOf("function");
  return (candidate as (...args: Args) => Promise<Result>).bind(service);
}

function readApi(service: CreditService): CreditReadApi {
  return {
    getMyAccount: requireReadMethod<
      [ReadContext],
      CreditAccountSnapshot | null
    >(service, "getMyAccount"),
    listMyLedger: requireReadMethod<[ReadContext, PageInput], LedgerPage>(
      service,
      "listMyLedger",
    ),
  };
}

type ObservedOperation = Readonly<{
  model: string | undefined;
  operation: string;
  args: unknown;
}>;

function assemble(
  fixture: PrismaDatabaseFixture,
  operations: ObservedOperation[],
  options: Partial<TransactionOptions> = {},
) {
  const observedClient = fixture.client.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        operations.push({ model, operation, args });
        // Prisma erases each operation's result type in this observation hook.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return await query(args);
      },
    },
  });
  // Same actual client/pool; the extension observes, never implements reads.
  const transactions = new TransactionService(
    observedClient as unknown as ConstructorParameters<
      typeof TransactionService
    >[0],
    options,
  );
  const repository = new CreditRepository(transactions);
  const effects = new CreditEffects(
    transactions,
    repository,
    new AuditAppender(transactions),
  );
  const service = new CreditWithReadRepository(
    transactions,
    new CommandReceiptRepository(transactions),
    effects,
    repository,
  );
  return { transactions, repository, effects, service };
}

async function expectCreditFailure(promise: Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CreditError);
  expect(failure).toMatchObject({ code });
}

function stringsIn(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((nested: unknown) =>
    stringsIn(nested, seen),
  );
}

function sqlStates(value: unknown, seen = new Set<object>()): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const node = value as Record<string, unknown>;
  return [
    ...[node.code, node.originalCode].filter(
      (code): code is string =>
        typeof code === "string" && /^[A-Z0-9]{5}$/u.test(code),
    ),
    ...[node.cause, node.meta, node.driverAdapterError].flatMap((nested) =>
      sqlStates(nested, seen),
    ),
  ];
}

const own: ReadContext = {
  tenantId: "credit-read-tenant-a",
  subjectId: "credit-read-subject-a",
};
const missing: ReadContext = {
  ...own,
  subjectId: "credit-read-no-wallet",
};
const anchor = new Date("2026-01-02T03:04:05.006Z");
const huge = 9007199254740993n;

function fixtureIdentityDigest(identity: {
  tenantId: string;
  subjectId: string;
}) {
  // Independent wire fixture: domain tag + uint32-BE UTF-8 byte lengths.
  const hash = createHash("sha256");
  hash.update("kokoro.billing.credit-ledger.identity.v1\0", "utf8");
  for (const value of [identity.tenantId, identity.subjectId]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("base64url");
}

function cursor(
  context: ReadContext,
  accountId: string,
  patch: Record<string, unknown> = {},
) {
  const { tenantId, subjectId, ...wirePatch } = patch;
  const identity = {
    tenantId: typeof tenantId === "string" ? tenantId : context.tenantId,
    subjectId: typeof subjectId === "string" ? subjectId : context.subjectId,
  };
  return Buffer.from(
    JSON.stringify({
      version: 1,
      scope: "credit.ledger",
      identityDigest: fixtureIdentityDigest(identity),
      accountId,
      highWaterSequence: "1",
      lastSequence: "1",
      ...wirePatch,
    }),
    "utf8",
  ).toString("base64url");
}

// These assertions intentionally distinguish absent capabilities from business
// RED. No method is imported from a nonexistent source/codec or called undefined.
test.each(["getMyAccount", "listMyLedger"] as const)(
  "Credit read capability %s",
  (key) => {
    expect(typeof Reflect.get(CreditService.prototype, key)).toBe("function");
  },
);

const adminUrl = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(adminUrl === undefined)("R43 canonical Credit reads", () => {
  let fixture: PrismaDatabaseFixture | undefined;
  let production: ReturnType<typeof assemble>;
  let operations: ObservedOperation[];

  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
    expect(new URL(fixture.url).pathname).toMatch(
      /^\/billing_reference_[a-f0-9]{32}$/u,
    );
    operations = [];
    production = assemble(fixture, operations);
  });

  afterEach(async () => {
    const owned = fixture;
    fixture = undefined;
    await owned?.close();
  });

  const api = () => readApi(production.service);
  const db = () => assertDefined(fixture).client;
  const grant = (context = own, amountMicros = 100n) => {
    const identity = randomUUID();
    // Fixture-only writer in the owned temporary database, not a gift endpoint.
    return production.service.grant({
      ...context,
      actorId: "fixture-only",
      amountMicros,
      sourceKind: "fixture",
      sourceRef: identity,
      programKey: "credit-read-fixture",
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      idempotencyKey: identity,
      commandIdentity: identity,
    });
  };
  const facts = async () => {
    const client = db();
    const order = { orderBy: { id: "asc" as const } };
    return Promise.all([
      client.billing_credit_account.findMany(order),
      client.billing_credit_grant.findMany(order),
      client.billing_credit_hold.findMany(order),
      client.billing_credit_hold_allocation.findMany(order),
      client.billing_credit_journal.findMany(order),
      client.billing_command_receipt.findMany(order),
      client.billing_command_key_binding.findMany(order),
      client.billing_audit_event.findMany(order),
      client.billing_outbox.findMany(order),
      client.billing_usage_event.findMany(order),
      client.billing_usage_settlement.findMany(order),
    ]);
  };
  const threeJournals = async () => {
    const first = await grant(own, 100n);
    const second = await grant(own, 20n);
    const third = await grant(own, 30n);
    await db().billing_credit_journal.updateMany({
      where: { tenant_id: own.tenantId, credit_account_id: first.accountId },
      data: { created_at: anchor },
    });
    return { first, second, third };
  };

  test("R01 reads the canonical own wallet", async () => {
    const reads = api();
    const seeded = await grant();
    operations.length = 0;
    expect(await reads.getMyAccount(own)).toEqual({
      id: seeded.accountId,
      tenantId: own.tenantId,
      subjectId: own.subjectId,
      status: "active",
      availableMicros: 100n,
      heldMicros: 0n,
    });
    expect(operations.some((op) => op.model === "billing_credit_account")).toBe(
      true,
    );
  });

  test("R02 missing wallet is null and GET never creates it", async () => {
    const reads = api();
    const before = await facts();
    expect(await reads.getMyAccount(missing)).toBeNull();
    expect(await facts()).toEqual(before);
  });

  test("R03 isolates the same subject across tenants", async () => {
    const reads = api();
    const a = await grant(own, 17n);
    const otherTenant = { ...own, tenantId: "credit-read-tenant-b" };
    const b = await grant(otherTenant, 999n);
    expect(await reads.getMyAccount(own)).toMatchObject({
      id: a.accountId,
      availableMicros: 17n,
    });
    expect(await reads.getMyAccount(otherTenant)).toMatchObject({
      id: b.accountId,
      availableMicros: 999n,
    });
    expect(
      await reads.getMyAccount({ ...own, tenantId: "credit-read-tenant-c" }),
    ).toBeNull();
    expect(
      (await reads.listMyLedger(own, {})).items.map((x) => x.journalId),
    ).toEqual([a.journalId]);
  });

  test("R04 isolates different subjects in one tenant", async () => {
    const reads = api();
    const a = await grant(own, 31n);
    const otherSubject = { ...own, subjectId: "credit-read-subject-b" };
    const b = await grant(otherSubject, 707n);
    expect((await reads.getMyAccount(own))?.id).toBe(a.accountId);
    expect((await reads.getMyAccount(otherSubject))?.id).toBe(b.accountId);
    expect(
      (await reads.listMyLedger(own, {})).items.map((x) => x.journalId),
    ).toEqual([a.journalId]);
    expect(
      (await reads.listMyLedger(otherSubject, {})).items.map(
        (x) => x.journalId,
      ),
    ).toEqual([b.journalId]);
  });

  test("R05 disabled wallet remains readable without a write", async () => {
    const reads = api();
    const seeded = await grant();
    await db().billing_credit_account.update({
      where: { id: seeded.accountId },
      data: { status: "disabled" },
    });
    const before = await facts();
    expect(await reads.getMyAccount(own)).toMatchObject({
      id: seeded.accountId,
      status: "disabled",
      availableMicros: 100n,
    });
    expect((await reads.listMyLedger(own, {})).items).toHaveLength(1);
    expect(await facts()).toEqual(before);
  });

  test("R06 keeps amounts, numeric SUM, sequence and UTC exact beyond 2^53", async () => {
    const reads = api();
    const seeded = await grant(own, huge);
    await db().billing_credit_journal.update({
      where: { id: seeded.journalId },
      data: { journal_seq: huge, created_at: anchor },
    });
    const wallet = assertDefined(await reads.getMyAccount(own));
    expect(wallet.availableMicros).toBe(huge);
    expect(wallet.availableMicros.toString()).toBe("9007199254740993");
    const entry = assertDefined((await reads.listMyLedger(own, {})).items[0]);
    expect(entry.sequence).toBe(huge);
    expect(entry.deltaMicros).toBe(huge);
    expect(entry.balanceAfterMicros).toBe(huge);
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.createdAt.toISOString()).toBe("2026-01-02T03:04:05.006Z");

    // A real owner capture supplies a signed debit, not a test read double.
    await grant(own, huge);
    const held = await production.service.reserve({
      tenantId: own.tenantId,
      actorId: "fixture-only",
      accountId: seeded.accountId,
      requestedMicros: huge,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      idempotencyKey: randomUUID(),
      commandIdentity: randomUUID(),
    });
    await production.transactions.runRoot(
      {
        tenantId: own.tenantId,
        actorId: "fixture-only",
        operation: "credit.read.fixture-capture",
        mode: "write",
      },
      () =>
        production.effects.capture({
          tenantId: own.tenantId,
          holdId: held.holdId,
          actualMicros: huge,
          sourceRef: randomUUID(),
        }),
    );
    const signed = await reads.listMyLedger(own, {});
    expect(signed.items.map((row) => row.sequence)).toEqual([
      huge + 2n,
      huge + 1n,
      huge,
    ]);
    expect(signed.items.map((row) => row.deltaMicros)).toEqual([
      -huge,
      huge,
      huge,
    ]);
    expect(signed.items.map((row) => row.balanceAfterMicros)).toEqual([
      huge,
      huge * 2n,
      huge,
    ]);
    expect(assertDefined(signed.items[0]).deltaMicros.toString()).toBe(
      "-9007199254740993",
    );
    expect(await reads.getMyAccount(own)).toMatchObject({
      availableMicros: huge,
      heldMicros: 0n,
    });
  });

  test("R07 ledger without own wallet is not_found, never fake empty", async () => {
    const reads = api();
    const before = await facts();
    await expectCreditFailure(
      reads.listMyLedger(missing, {}),
      "CREDIT_ACCOUNT_NOT_FOUND",
    );
    expect(await facts()).toEqual(before);
  });

  test("R08 an existing wallet with no journal is a real empty page", async () => {
    const reads = api();
    await db().billing_credit_account.create({
      data: {
        id: randomUUID(),
        tenant_id: own.tenantId,
        subject_id: own.subjectId,
      },
    });
    const before = await facts();
    expect(await reads.listMyLedger(own, {})).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await facts()).toEqual(before);
  });

  test("R09 equal timestamps paginate by descending unique sequence", async () => {
    const reads = api();
    const seeded = await threeJournals();
    const ids: string[] = [];
    const sequences: bigint[] = [];
    let next: string | undefined;
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await reads.listMyLedger(own, {
        limit: 1,
        ...(next === undefined ? {} : { cursor: next }),
      });
      expect(page.items).toHaveLength(1);
      const row = assertDefined(page.items[0]);
      ids.push(row.journalId);
      sequences.push(row.sequence);
      expect(row.createdAt.toISOString()).toBe(anchor.toISOString());
      if (pageNumber < 2) {
        expect(page.nextCursor).toBeTypeOf("string");
        next = assertDefined(page.nextCursor);
      } else expect(page.nextCursor).toBeNull();
    }
    expect(ids).toEqual([
      seeded.third.journalId,
      seeded.second.journalId,
      seeded.first.journalId,
    ]);
    expect(new Set(ids).size).toBe(3);
    expect(sequences).toEqual([3n, 2n, 1n]);
  });

  test("R10 balanceAfter is full-history SUM before page slicing, not available", async () => {
    const reads = api();
    const seeded = await threeJournals();
    await production.service.reserve({
      tenantId: own.tenantId,
      actorId: "fixture-only",
      accountId: seeded.first.accountId,
      requestedMicros: 40n,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      idempotencyKey: randomUUID(),
      commandIdentity: randomUUID(),
    });
    expect(await reads.getMyAccount(own)).toMatchObject({
      availableMicros: 110n,
      heldMicros: 40n,
    });
    const first = await reads.listMyLedger(own, { limit: 1 });
    expect(first.items[0]).toMatchObject({
      sequence: 3n,
      deltaMicros: 30n,
      balanceAfterMicros: 150n,
    });
    const second = await reads.listMyLedger(own, {
      limit: 1,
      cursor: assertDefined(first.nextCursor),
    });
    expect(second.items[0]).toMatchObject({
      sequence: 2n,
      deltaMicros: 20n,
      balanceAfterMicros: 120n,
    });
  });

  test("R11 validates limit instead of clamping or coercing bad component input", async () => {
    const reads = api();
    const seeded = await grant(own, 101n);
    // Owned canonical rows make default/maximum slicing observable, without
    // 101 command transactions or another read implementation.
    await db().billing_credit_journal.update({
      where: { id: seeded.journalId },
      data: { amount_micros: 1n },
    });
    await db().billing_credit_journal.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        tenant_id: own.tenantId,
        credit_account_id: seeded.accountId,
        journal_seq: BigInt(index + 2),
        entry_kind: "adjustment",
        amount_micros: 1n,
        source_kind: "fixture",
        source_ref: randomUUID(),
      })),
    });
    for (const [page, length] of [
      [{}, 50],
      [{ limit: 1 }, 1],
      [{ limit: 100 }, 100],
    ] as const) {
      const result = await reads.listMyLedger(own, page);
      expect(result.items).toHaveLength(length);
      expect(result.items[0]?.sequence).toBe(101n);
      expect(result.items.at(-1)?.sequence).toBe(102n - BigInt(length));
      expect(result.nextCursor).toBeTypeOf("string");
    }
    const maximum = await reads.listMyLedger(own, { limit: 100 });
    const tail = await reads.listMyLedger(own, {
      limit: 100,
      cursor: assertDefined(maximum.nextCursor),
    });
    expect(tail.items.map((row) => row.sequence)).toEqual([1n]);
    expect(tail.nextCursor).toBeNull();
    const invalid: unknown[] = [
      { limit: 0 },
      { limit: 101 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: NaN },
      { limit: Infinity },
      { limit: "1" },
      { limit: null },
      { limit: true },
      { unknown: 1 },
    ];
    for (const page of invalid) {
      operations.length = 0;
      await expectCreditFailure(
        reads.listMyLedger(own, page as PageInput),
        "CREDIT_INVALID_QUERY",
      );
      expect(operations).toEqual([]);
    }
  });

  test("R12 malformed cursor is rejected before any SQL", async () => {
    const reads = api();
    const seeded = await grant();
    const invalid: unknown[] = [
      "",
      "x".repeat(2049),
      "not%base64url",
      Buffer.from([0xff]).toString("base64url"),
      Buffer.from("{", "utf8").toString("base64url"),
      Buffer.from("null", "utf8").toString("base64url"),
      Buffer.from("[]", "utf8").toString("base64url"),
      Buffer.from("{}", "utf8").toString("base64url"),
      false,
      1,
      {},
      cursor(own, seeded.accountId, { version: 2 }),
      cursor(own, seeded.accountId, { version: "1" }),
      cursor(own, seeded.accountId, { scope: "other" }),
      cursor(own, seeded.accountId, { extra: "not-allowed" }),
      cursor(own, seeded.accountId, { accountId: "not-a-uuid" }),
      cursor(own, seeded.accountId, { lastSequence: "01" }),
      cursor(own, seeded.accountId, { lastSequence: "-1" }),
      cursor(own, seeded.accountId, { lastSequence: 1 }),
      cursor(own, seeded.accountId, { lastSequence: undefined }),
      cursor(own, seeded.accountId, { highWaterSequence: undefined }),
      cursor(own, seeded.accountId, { highWaterSequence: "01" }),
      cursor(own, seeded.accountId, { highWaterSequence: "-1" }),
      cursor(own, seeded.accountId, { highWaterSequence: 1 }),
      cursor(own, seeded.accountId, { highWaterSequence: "1.5" }),
      cursor(own, seeded.accountId, { highWaterSequence: null }),
    ];
    for (const value of invalid) {
      operations.length = 0;
      await expectCreditFailure(
        reads.listMyLedger(own, { cursor: value } as PageInput),
        "CREDIT_INVALID_CURSOR",
      );
      expect(operations).toEqual([]);
    }
  });

  test("R13 foreign tenant/subject cursor is invalid with zero SQL", async () => {
    const reads = api();
    const seeded = await grant();
    for (const patch of [
      { tenantId: "foreign-tenant" },
      { subjectId: "foreign-subject" },
    ]) {
      operations.length = 0;
      await expectCreditFailure(
        reads.listMyLedger(own, {
          cursor: cursor(own, seeded.accountId, patch),
        }),
        "CREDIT_INVALID_CURSOR",
      );
      expect(operations).toEqual([]);
    }
  });

  test("R14 foreign account cursor never becomes a query selector", async () => {
    const reads = api();
    await grant();
    const other = await grant({ ...own, subjectId: "foreign-account-owner" });
    operations.length = 0;
    await expectCreditFailure(
      reads.listMyLedger(own, { cursor: cursor(own, other.accountId) }),
      "CREDIT_INVALID_CURSOR",
    );
    expect(
      operations
        .flatMap((op) => stringsIn(op.args))
        .some((s) => s.includes(other.accountId)),
    ).toBe(false);
  });

  test("R15 nonexistent/inverted same-account boundaries never reset pagination", async () => {
    const reads = api();
    const seeded = await threeJournals();
    for (const patch of [
      { highWaterSequence: "2", lastSequence: "3" },
      { highWaterSequence: "4", lastSequence: "2" },
      { highWaterSequence: "3", lastSequence: "0" },
      { highWaterSequence: "9007199254740993", lastSequence: "2" },
    ])
      await expectCreditFailure(
        reads.listMyLedger(own, {
          cursor: cursor(own, seeded.first.accountId, patch),
        }),
        "CREDIT_INVALID_CURSOR",
      );
  });

  test("R16 an appended journal cannot enter an older high-water cursor", async () => {
    const reads = api();
    const seeded = await threeJournals();
    const first = await reads.listMyLedger(own, { limit: 1 });
    const next = assertDefined(first.nextCursor);
    const beforeAppend = await reads.listMyLedger(own, {
      limit: 1,
      cursor: next,
    });
    const appended = await grant(own, 7n);
    await db().billing_credit_journal.update({
      where: { id: appended.journalId },
      data: { created_at: anchor },
    });
    const afterAppend = await reads.listMyLedger(own, {
      limit: 1,
      cursor: next,
    });
    expect(afterAppend).toEqual(beforeAppend);
    expect(afterAppend.items[0]?.journalId).toBe(seeded.second.journalId);
    const last = await reads.listMyLedger(own, {
      limit: 1,
      cursor: assertDefined(afterAppend.nextCursor),
    });
    expect(last.items[0]?.journalId).toBe(seeded.first.journalId);
    expect(last.nextCursor).toBeNull();
    expect(
      (await reads.listMyLedger(own, { limit: 1 })).items[0]?.journalId,
    ).toBe(appended.journalId);
  });

  test("R17 successful/failed reads leave every fact unchanged and DB rejects writes", async () => {
    const reads = api();
    const seeded = await grant();
    const before = await facts();
    for (const read of [
      () => reads.getMyAccount(own),
      () => reads.listMyLedger(own, {}),
    ]) {
      operations.length = 0;
      await read();
      // Observe the actual TransactionService query, not a simulated scope.
      expect(
        operations.some(
          (op) =>
            op.operation === "$executeRaw" &&
            stringsIn(op.args).join(" ").includes("SET TRANSACTION READ ONLY"),
        ),
      ).toBe(true);
    }
    expect(await reads.getMyAccount(missing)).toBeNull();
    await expectCreditFailure(
      reads.listMyLedger(missing, {}),
      "CREDIT_ACCOUNT_NOT_FOUND",
    );
    await expectCreditFailure(
      reads.listMyLedger(own, { cursor: "invalid%" }),
      "CREDIT_INVALID_CURSOR",
    );
    let mutationFailure: unknown;
    try {
      await production.transactions.runRoot(
        {
          tenantId: own.tenantId,
          actorId: own.subjectId,
          operation: "credit.read.fixture-read-only-probe",
          mode: "readOnlySnapshot",
        },
        async () => {
          const client = production.transactions.requireActiveTransaction(
            own.tenantId,
            "readOnlySnapshot",
          );
          await client.billing_credit_account.update({
            where: { id: seeded.accountId },
            data: { generation: { increment: 1n } },
          });
        },
      );
    } catch (error) {
      mutationFailure = error;
    }
    expect(sqlStates(mutationFailure)).toContain("25006");
    expect(await facts()).toEqual(before);
    expect(await reads.getMyAccount(own)).toMatchObject({
      availableMicros: 100n,
    });
  });

  test("R18 wrong-tenant child, negative SUM and illegal rows fail closed; timeout recovers", async () => {
    const reads = api();
    const wrongTenant = { ...own, subjectId: "corrupt-child" };
    const child = await grant(wrongTenant);
    await db().billing_credit_journal.update({
      where: { id: child.journalId },
      data: { tenant_id: "different-tenant-child" },
    });
    const negative = { ...own, subjectId: "corrupt-negative-sum" };
    const negativeWallet = await grant(negative, 100n);
    await db().billing_credit_journal.create({
      data: {
        id: randomUUID(),
        tenant_id: negative.tenantId,
        credit_account_id: negativeWallet.accountId,
        journal_seq: 2n,
        entry_kind: "adjustment",
        amount_micros: -101n,
        source_kind: "fixture-corruption",
        source_ref: randomUUID(),
      },
    });
    const illegalContexts: ReadContext[] = [];
    for (const field of ["source_kind", "source_ref"] as const) {
      const context = { ...own, subjectId: `corrupt-${field}` };
      const illegal = await grant(context);
      await db().billing_credit_journal.update({
        where: { id: illegal.journalId },
        data: { [field]: "" },
      });
      illegalContexts.push(context);
    }
    const healthy = { ...own, subjectId: "timeout-healthy" };
    const healthyWallet = await grant(healthy);
    const before = await facts();
    for (const context of [wrongTenant, negative, ...illegalContexts])
      await expectCreditFailure(
        reads.listMyLedger(context, {}),
        "CREDIT_READ_CORRUPT",
      );
    expect(await facts()).toEqual(before);

    const limited = assemble(assertDefined(fixture), [], {
      timeoutMs: 2_000,
      statementTimeoutMs: 200,
      lockTimeoutMs: 50,
      idleInTransactionTimeoutMs: 2_000,
    });
    const limitedReads = readApi(limited.service);
    const blocker = await assertDefined(fixture).pool.connect();
    let timeoutFailure: unknown;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE billing_credit_account IN ACCESS EXCLUSIVE MODE",
      );
      try {
        await limitedReads.getMyAccount(healthy);
      } catch (error) {
        timeoutFailure = error;
      }
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }
    expect(
      sqlStates(timeoutFailure).some((code) =>
        ["55P03", "57014"].includes(code),
      ),
    ).toBe(true);
    expect(await limitedReads.getMyAccount(healthy)).toMatchObject({
      id: healthyWallet.accountId,
      availableMicros: 100n,
    });
    expect(await facts()).toEqual(before);
  }, 15_000);

  test("R19 legal tenant191/subject255 UTF-8 identities paginate without GET writes", async () => {
    const reads = api();
    const identity: ReadContext = {
      tenantId: "😀".repeat(191),
      subjectId: "🦊".repeat(255),
    };
    const first = await grant(identity, 31n);
    const second = await grant(identity, 17n);
    const before = await facts();
    try {
      expect(await reads.getMyAccount(identity)).toEqual({
        id: first.accountId,
        ...identity,
        status: "active",
        availableMicros: 48n,
        heldMicros: 0n,
      });
      const head = await reads.listMyLedger(identity, { limit: 1 });
      expect(head.items).toHaveLength(1);
      expect(head.items[0]).toMatchObject({
        journalId: second.journalId,
        sequence: 2n,
        deltaMicros: 17n,
        balanceAfterMicros: 48n,
      });
      const next = assertDefined(head.nextCursor);
      expect(next.length).toBeLessThanOrEqual(2048);
      const tail = await reads.listMyLedger(identity, {
        limit: 1,
        cursor: next,
      });
      expect(tail.items).toHaveLength(1);
      expect(tail.items[0]).toMatchObject({
        journalId: first.journalId,
        sequence: 1n,
        deltaMicros: 31n,
        balanceAfterMicros: 31n,
      });
      expect(tail.nextCursor).toBeNull();
      expect(
        await reads.listMyLedger(identity, { limit: 1, cursor: next }),
      ).toEqual(tail);
    } finally {
      expect(await facts()).toEqual(before);
    }
  });
});
