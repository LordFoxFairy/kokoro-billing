import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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
    let jwksServer: Server;
    let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
    const accountPath = "/v2/billing/me/credit-account";
    const ledgerPath = "/v2/billing/me/credit-ledger";
    const profile = {
      mode: "jwks" as const,
      internalServiceSecret: "r74-http-pg-service-secret-0000000001",
      bffServiceToken: "r74-http-pg-bff-bearer-token-00000001",
      operatorProxySecret: "r74-http-pg-operator-secret-000000001",
      jwksUrl: "",
      issuer: "https://iam.example.test/iam",
      audience: "https://kokoro.dev/resources/billing",
    };
    const own = (subject: string = randomUUID()): CreditReadContext => ({
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
      const keys = await generateKeyPair("EdDSA");
      signingKey = keys.privateKey;
      const jwk = await exportJWK(keys.publicKey);
      jwksServer = createServer((request, response) => {
        if (request.method !== "GET" || request.url !== "/iam/jwks") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            keys: [{ ...jwk, kid: "r255-iam-ed25519", alg: "EdDSA" }],
          }),
        );
      });
      await new Promise<void>((resolve, reject) => {
        jwksServer.once("error", reject);
        jwksServer.listen(0, "127.0.0.1", () => {
          jwksServer.removeListener("error", reject);
          resolve();
        });
      });
      const address = jwksServer.address();
      if (address === null || typeof address === "string")
        throw new Error("JWKS fixture did not bind a TCP port");
      profile.jwksUrl = `http://127.0.0.1:${address.port}/iam/jwks`;
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
        try {
          await fixture?.close();
        } finally {
          await new Promise<void>((resolve, reject) => {
            if (!jwksServer?.listening) {
              resolve();
              return;
            }
            jwksServer.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          });
        }
      }
    });
    const facts = async () => {
      // Observe every canonical table in this fixture's owner-only temporary DB,
      // including non-Credit receipts/payment facts. PG JSON text keeps bigint exact.
      const tables = await fixture.pool.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'kokoro_billing' ORDER BY tablename",
      );
      expect(tables.rows).toHaveLength(35);
      return Promise.all(
        tables.rows.map(async ({ name }) => {
          if (!/^[a-z][a-z0-9_]*$/u.test(name))
            throw new Error("Invalid canonical fixture table");
          const rows = await fixture.pool.query<{ row: string }>(
            `SELECT to_jsonb(t)::text AS row FROM kokoro_billing."${name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
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
    const signUser = async (
      patch: {
        scope?: string;
        audience?: string | readonly string[];
        kind?: string;
        tenant?: string;
        omitSid?: boolean;
        expiresAt?: number;
        operator?: boolean;
        cnf?: Readonly<Record<string, string>>;
        plainTenantOnly?: boolean;
        notBefore?: number;
        issuedAt?: number;
        signingKey?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
        algorithm?: "EdDSA" | "RS256";
      } = {},
    ) => {
      const payload: Record<string, unknown> = {
        sid: randomUUID(),
        client_id: "r255-web-client",
        scope: patch.scope ?? "billing:credit.consume",
        "https://kokoro.dev/token_kind": patch.kind ?? "user_delegated",
        "https://kokoro.dev/tenant_id": patch.tenant ?? "r74-owner-http",
        ...(patch.operator === undefined
          ? {}
          : { "https://kokoro.dev/operator": patch.operator }),
        ...(patch.cnf === undefined ? {} : { cnf: patch.cnf }),
      };
      if (patch.omitSid === true) delete payload.sid;
      if (patch.plainTenantOnly === true) {
        payload.tenant_id = payload["https://kokoro.dev/tenant_id"];
        delete payload["https://kokoro.dev/tenant_id"];
      }
      let token = new SignJWT(payload)
        .setProtectedHeader({
          alg: patch.algorithm ?? "EdDSA",
          kid: "r255-iam-ed25519",
          typ: "JWT",
        })
        .setIssuer(profile.issuer)
        .setAudience(
          patch.audience === undefined
            ? profile.audience
            : typeof patch.audience === "string"
              ? patch.audience
              : [...patch.audience],
        )
        .setSubject("r255-user")
        .setIssuedAt(patch.issuedAt)
        .setExpirationTime(
          patch.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
        );
      if (patch.notBefore !== undefined)
        token = token.setNotBefore(patch.notBefore);
      return token.sign(patch.signingKey ?? signingKey);
    };
    it("accepts a complete IAM EdDSA user profile without mutating owner facts", async () => {
      const context = own("r255-user");
      const result = await seed(context, 321n);
      const before = await facts();
      const token = await signUser();
      const userHeaders = {
        authorization: `Bearer ${token}`,
        "x-kokoro-tenant-id": encode(context.tenantId),
        "x-request-id": "r74-real-pg-1",
      };

      const account = await app.inject({
        method: "GET",
        url: accountPath,
        headers: userHeaders,
      });
      expect(await facts()).toEqual(before);
      check(account, 200);
      schemas.assert("CreditAccountResponse", account.json<unknown>());
      expect(account.json<CreditAccountResponse>().data).toMatchObject({
        credit_account_id: result.accountId,
        available_micros: "321",
      });

      const ledger = await app.inject({
        method: "GET",
        url: ledgerPath,
        headers: userHeaders,
      });
      expect(await facts()).toEqual(before);
      check(ledger, 200);
      schemas.assert("CreditLedgerResponse", ledger.json<unknown>());
      expect(ledger.json<CreditLedgerResponse>().data.items).toHaveLength(1);
    });
    it("accepts the exact OpenID dual audience in both orders without owner writes", async () => {
      const context = own("r255-user");
      await seed(context, 321n);
      const before = await facts();
      const userinfo = profile.issuer + "/oauth2/userinfo";
      for (const audience of [
        [profile.audience, userinfo],
        [userinfo, profile.audience],
      ]) {
        const response = await app.inject({
          method: "GET",
          url: accountPath,
          headers: {
            authorization: `Bearer ${await signUser({ scope: "billing:credit.consume openid", audience })}`,
            "x-kokoro-tenant-id": encode(context.tenantId),
            "x-request-id": "r74-real-pg-1",
          },
        });
        expect(await facts()).toEqual(before);
        check(response, 200);
      }
    });
    it.each([
      ["wrong scope", { scope: "openid" }, "r74-owner-http", 401],
      [
        "wrong audience",
        { audience: "https://kokoro.dev/resources/iam-internal" },
        "r74-owner-http",
        401,
      ],
      ["machine token kind", { kind: "machine" }, "r74-owner-http", 401],
      ["operator claim", { operator: true }, "r74-owner-http", 401],
      [
        "confirmation claim",
        { cnf: { jkt: "fixture" } },
        "r74-owner-http",
        401,
      ],
      [
        "legacy plain tenant only",
        { plainTenantOnly: true },
        "r74-owner-http",
        401,
      ],
      [
        "OpenID wrong userinfo audience",
        {
          scope: "billing:credit.consume openid",
          audience: [profile.audience, profile.issuer + "/oauth2/wrong"],
        },
        "r74-owner-http",
        401,
      ],
      [
        "future not-before",
        { notBefore: Math.floor(Date.now() / 1000) + 300 },
        "r74-owner-http",
        401,
      ],
      [
        "unsafe issued-at integer",
        { issuedAt: Number.MAX_SAFE_INTEGER + 1 },
        "r74-owner-http",
        401,
      ],
      ["missing sid", { omitSid: true }, "r74-owner-http", 401],
      ["expired token", { expiresAt: 1 }, "r74-owner-http", 401],
      ["cross-tenant header", {}, "r74-foreign", 403],
    ] as const)(
      "rejects a signed IAM profile with %s before owner writes",
      async (_label, patch, headerTenant, status) => {
        const context = own("r255-user");
        await seed(context, 321n);
        const before = await facts();
        const response = await app.inject({
          method: "GET",
          url: accountPath,
          headers: {
            authorization: `Bearer ${await signUser(patch)}`,
            "x-kokoro-tenant-id": encode(headerTenant),
            "x-request-id": "r74-real-pg-1",
          },
        });
        expect(await facts()).toEqual(before);
        check(response, status);
      },
    );
    it("rejects a correctly shaped RSA profile without owner writes", async () => {
      const context = own("r255-user");
      await seed(context, 321n);
      const before = await facts();
      const rsa = await generateKeyPair("RS256");
      const response = await app.inject({
        method: "GET",
        url: accountPath,
        headers: {
          authorization: `Bearer ${await signUser({ algorithm: "RS256", signingKey: rsa.privateKey })}`,
          "x-kokoro-tenant-id": encode(context.tenantId),
          "x-request-id": "r74-real-pg-1",
        },
      });
      expect(await facts()).toEqual(before);
      check(response, 401);
    });
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
