import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import { BillingHttpModule } from "../../src/http/billing-http.module.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import {
  CreditEffects,
  CreditService,
} from "../../src/modules/credit/credit.service.js";
import type { CreditReadContext } from "../../src/modules/credit/credit.types.js";
import type {
  CreditAccountResponse,
  CreditLedgerResponse,
  ErrorResponse,
} from "../../src/generated/billing-api/types.gen.js";
import { BILLING_SCHEMA_VALIDATOR } from "../../src/infrastructure/auth/billing-auth.types.js";
import type { BillingSchemaValidator } from "../../src/infrastructure/auth/billing-auth.types.js";
import { createPrismaDatabaseFixture } from "./prisma-database.fixture.js";
import type { PrismaDatabaseFixture } from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
// Root alone supplies owner-isolated real PostgreSQL resources. No auto-start,
// provider doubles, reset of shared state or fixed application credentials.
describe.skipIf(adminUrl === undefined)(
  "R74 real owner personal Credit HTTP",
  () => {
    let fixture: PrismaDatabaseFixture;
    let app: NestFastifyApplication;
    let credit: CreditService;
    let schemas: BillingSchemaValidator;
    const accountPath = "/v2/billing/me/credit-account";
    const ledgerPath = "/v2/billing/me/credit-ledger";
    const profile = {
      mode: "jwks" as const,
      internalServiceSecret: "r74-http-pg-service-secret-0000000001",
      bffServiceToken: "r74-http-pg-bff-bearer-token-00000001",
      operatorProxySecret: "r74-http-pg-operator-secret-000000001",
      // Machine-only fixture deliberately performs no JWKS fetch.
      jwksUrl: "http://127.0.0.1:1/unused-machine-jwks",
      issuer: "r74-local-iam",
      audience: "r74-local-billing",
    };
    const own = (subject = randomUUID()): CreditReadContext => ({
      tenantId: "r74-owner-http",
      subjectId: subject,
    });
    const encode = (value: string) =>
      "u1." + Buffer.from(value, "utf8").toString("base64url");
    const headers = (context: CreditReadContext) => ({
      "x-kokoro-service": "web-bff",
      "x-kokoro-internal-secret": profile.internalServiceSecret,
      authorization: `Bearer ${profile.bffServiceToken}`,
      "x-kokoro-tenant-id": encode(context.tenantId),
      "x-kokoro-subject": encode(context.subjectId),
      "x-request-id": "r74-real-pg-1",
    });
    beforeAll(async () => {
      if (adminUrl === undefined)
        throw new Error("Root must provide SCHEMA_ADMIN_URL");
      fixture = await createPrismaDatabaseFixture(adminUrl);
      expect(new URL(fixture.url).pathname).toMatch(
        /^\/billing_reference_[a-f0-9]{32}$/u,
      );
      const moduleRef = await Test.createTestingModule({
        imports: [
          DatabaseModule.register({ databaseUrl: fixture.url }),
          BillingHttpModule.register(profile),
        ],
      }).compile();
      const adapter = new FastifyAdapter({ logger: false });
      app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
      await app.init();
      await adapter.getInstance().ready();
      credit = app.get(CreditService);
      schemas = app.get(BILLING_SCHEMA_VALIDATOR);
    });
    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.close();
      }
    });
    const facts = async () => {
      // Observe every canonical table in this fixture's owner-only temporary DB,
      // including non-Credit receipts/payment facts. PG JSON text keeps bigint exact.
      const tables = await fixture.pool.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      expect(tables.rows.length).toBeGreaterThan(11);
      return Promise.all(
        tables.rows.map(async ({ name }) => {
          if (!/^[a-z][a-z0-9_]*$/u.test(name))
            throw new Error("Invalid canonical fixture table");
          const rows = await fixture.pool.query<{ row: string }>(
            `SELECT to_jsonb(t)::text AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
          );
          return { table: name, rows: rows.rows.map(({ row }) => row) };
        }),
      );
    };
    const seed = (context: CreditReadContext, amountMicros = 100n) => {
      const id = randomUUID();
      return credit.grant({
        ...context,
        actorId: "fixture-only",
        amountMicros,
        sourceKind: "fixture",
        sourceRef: id,
        programKey: "r74-http-fixture",
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        idempotencyKey: id,
        commandIdentity: id,
      });
    };
    function check(
      response: Awaited<ReturnType<NestFastifyApplication["inject"]>>,
      status: number,
    ) {
      expect(response.statusCode).toBe(status);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-request-id"]).toBe("r74-real-pg-1");
      expect(response.headers["x-kokoro-request-id"]).toBeUndefined();
      expect(response.body).not.toContain("PRIVATE_DB_DETAIL");
      if (status !== 200)
        schemas.assert("ErrorResponse", response.json<unknown>());
    }
    it("reads >2^53 bigint and UTC from the real writer/Repository with all facts unchanged", async () => {
      const context = own();
      const result = await seed(context, 9_007_199_254_740_993n);
      const instant = new Date("2026-01-02T03:04:05.006Z");
      await fixture.client.billing_credit_journal.update({
        where: { id: result.journalId },
        data: { created_at: instant },
      });
      const before = await facts();
      const account = await app.inject({
        method: "GET",
        url: accountPath,
        headers: headers(context),
      });
      check(account, 200);
      schemas.assert("CreditAccountResponse", account.json<unknown>());
      expect(account.json<CreditAccountResponse>().data).toEqual({
        credit_account_id: result.accountId,
        status: "active",
        available_micros: "9007199254740993",
        held_micros: "0",
      });
      const ledger = await app.inject({
        method: "GET",
        url: ledgerPath,
        headers: headers(context),
      });
      check(ledger, 200);
      schemas.assert("CreditLedgerResponse", ledger.json<unknown>());
      expect(ledger.json<CreditLedgerResponse>().data.items).toEqual([
        {
          journal_id: result.journalId,
          sequence: "1",
          delta_micros: "9007199254740993",
          balance_after_micros: "9007199254740993",
          source_kind: "fixture",
          source_ref: (
            await fixture.client.billing_credit_journal.findUniqueOrThrow({
              where: { id: result.journalId },
            })
          ).source_ref,
          created_at: instant.toISOString(),
        },
      ]);
      expect(await facts()).toEqual(before);
    });
    it("maps a real owner capture debit exactly beyond 2^53, without GET writes", async () => {
      const context = own();
      const huge = 9_007_199_254_740_993n;
      const seeded = await seed(context, huge);
      await seed(context, huge);
      const hold = await credit.reserve({
        tenantId: context.tenantId,
        actorId: "fixture-only",
        accountId: seeded.accountId,
        requestedMicros: huge,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        idempotencyKey: randomUUID(),
        commandIdentity: randomUUID(),
      });
      await app.get(TransactionService).runRoot(
        {
          tenantId: context.tenantId,
          actorId: "fixture-only",
          operation: "r74.http.fixture-capture",
          mode: "write",
        },
        () =>
          app.get(CreditEffects).capture({
            tenantId: context.tenantId,
            holdId: hold.holdId,
            actualMicros: huge,
            sourceRef: randomUUID(),
          }),
      );
      const instant = new Date("2026-01-02T03:04:05.006Z");
      await fixture.client.billing_credit_journal.updateMany({
        where: { credit_account_id: seeded.accountId },
        data: { created_at: instant },
      });
      const before = await facts();
      const response = await app.inject({
        method: "GET",
        url: ledgerPath,
        headers: headers(context),
      });
      check(response, 200);
      schemas.assert("CreditLedgerResponse", response.json<unknown>());
      expect(response.json<CreditLedgerResponse>().data.items[0]).toMatchObject(
        {
          delta_micros: "-9007199254740993",
          balance_after_micros: "9007199254740993",
          created_at: instant.toISOString(),
        },
      );
      expect(await facts()).toEqual(before);
    });
    it("returns 404 for missing wallet in either read without creating account/receipts", async () => {
      const context = own();
      const before = await facts();
      for (const path of [accountPath, ledgerPath]) {
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: headers(context),
        });
        check(response, 404);
        expect(response.json<ErrorResponse>().error.code).toBe(
          "billing.not_found",
        );
      }
      expect(await facts()).toEqual(before);
    });
    it("reads disabled empty wallets as canonical empty pages, never initializes history", async () => {
      const context = own();
      const id = randomUUID();
      await fixture.client.billing_credit_account.create({
        data: {
          id,
          tenant_id: context.tenantId,
          subject_id: context.subjectId,
          status: "disabled",
          available_micros: 0n,
          held_micros: 0n,
          generation: 0n,
        },
      });
      const before = await facts();
      const account = await app.inject({
        method: "GET",
        url: accountPath,
        headers: headers(context),
      });
      check(account, 200);
      expect(account.json<CreditAccountResponse>().data.status).toBe(
        "disabled",
      );
      const page = await app.inject({
        method: "GET",
        url: ledgerPath,
        headers: headers(context),
      });
      check(page, 200);
      expect(page.json<unknown>()).toEqual({
        data: { items: [], page: { next_cursor: null } },
      });
      expect(await facts()).toEqual(before);
    });
    it("paginates real journals and rejects foreign tenant/subject cursor before any writes", async () => {
      const context = own();
      await seed(context);
      await seed(context, 20n);
      await seed(context, 30n);
      const before = await facts();
      const first = await app.inject({
        method: "GET",
        url: ledgerPath + "?limit=1",
        headers: headers(context),
      });
      check(first, 200);
      const next = first.json<CreditLedgerResponse>().data.page.next_cursor;
      expect(next).toBeTypeOf("string");
      if (next === null) throw new Error("Missing next cursor");
      const second = await app.inject({
        method: "GET",
        url: ledgerPath + "?limit=1&cursor=" + encodeURIComponent(next),
        headers: headers(context),
      });
      check(second, 200);
      expect(first.json<CreditLedgerResponse>().data.items[0]?.sequence).toBe(
        "3",
      );
      expect(second.json<CreditLedgerResponse>().data.items[0]?.sequence).toBe(
        "2",
      );
      for (const foreign of [
        { ...context, tenantId: "r74-foreign" },
        { ...context, subjectId: "r74-foreign" },
      ]) {
        const rejected = await app.inject({
          method: "GET",
          url: ledgerPath + "?cursor=" + encodeURIComponent(next),
          headers: headers(foreign),
        });
        check(rejected, 400);
        expect(rejected.json<ErrorResponse>().error.code).toBe(
          "billing.invalid_request",
        );
      }
      expect(await facts()).toEqual(before);
    });
    it("preserves maximal Unicode, leading BOM, spaces and NFD/NFC identities in real owner reads", async () => {
      for (const context of [
        { tenantId: "😀".repeat(191), subjectId: "🦊".repeat(255) },
        { tenantId: "\uFEFFr74-tenant", subjectId: "\uFEFFr74-subject" },
        { tenantId: " r74-tenant ", subjectId: " r74-subject " },
        { tenantId: "r74-e\u0301", subjectId: "r74-e\u0301" },
        { tenantId: "r74-é", subjectId: "r74-é" },
      ]) {
        const seeded = await seed(context);
        const before = await facts();
        const account = await app.inject({
          method: "GET",
          url: accountPath,
          headers: headers(context),
        });
        check(account, 200);
        expect(
          account.json<CreditAccountResponse>().data.credit_account_id,
        ).toBe(seeded.accountId);
        const page = await app.inject({
          method: "GET",
          url: ledgerPath,
          headers: headers(context),
        });
        check(page, 200);
        expect(page.json<CreditLedgerResponse>().data.items).toHaveLength(1);
        expect(await facts()).toEqual(before);
      }
    });
    it("returns safe 500 for corrupt history then recovers without GET facts mutations", async () => {
      const context = own();
      const result = await seed(context);
      await fixture.client.billing_credit_journal.update({
        where: { id: result.journalId },
        data: { source_ref: "" },
      });
      const before = await facts();
      const failed = await app.inject({
        method: "GET",
        url: ledgerPath,
        headers: headers(context),
      });
      check(failed, 500);
      expect(failed.json<ErrorResponse>().error).toMatchObject({
        code: "billing.internal_error",
        retryable: false,
      });
      expect(await facts()).toEqual(before);
      // Only the fixture writer repairs its own intentionally corrupted row.
      await fixture.client.billing_credit_journal.update({
        where: { id: result.journalId },
        data: { source_ref: "repaired-fixture" },
      });
      const repaired = await facts();
      check(
        await app.inject({
          method: "GET",
          url: ledgerPath,
          headers: headers(context),
        }),
        200,
      );
      expect(await facts()).toEqual(repaired);
    });
    it("maps genuine bounded PostgreSQL lock failure to safe 503 and recovers", async () => {
      const context = own();
      await seed(context);
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: headers(context),
        }),
        200,
      );
      const before = await facts();
      const blocker = await fixture.pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "LOCK TABLE billing_credit_account IN ACCESS EXCLUSIVE MODE",
        );
        const failed = await app.inject({
          method: "GET",
          url: accountPath,
          headers: headers(context),
        });
        check(failed, 503);
        expect(failed.json<ErrorResponse>().error).toMatchObject({
          code: "billing.dependency_unavailable",
          retryable: true,
        });
      } finally {
        try {
          await blocker.query("ROLLBACK");
        } finally {
          blocker.release();
        }
      }
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: headers(context),
        }),
        200,
      );
      expect(await facts()).toEqual(before);
    }, 15_000);
    it("rejects malformed/partial auth and strict queries before touching any owner facts", async () => {
      const context = own();
      await seed(context);
      const before = await facts();
      const incomplete: Record<string, string> = headers(context);
      delete incomplete["x-kokoro-subject"];
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: incomplete,
        }),
        403,
      );
      check(
        await app.inject({
          method: "GET",
          url: ledgerPath,
          headers: { ...headers(context), "x-kokoro-subject": "raw-subject" },
        }),
        400,
      );
      check(
        await app.inject({
          method: "GET",
          url: ledgerPath + "?limit=01",
          headers: headers(context),
        }),
        400,
      );
      expect(await facts()).toEqual(before);
    });
  },
);
