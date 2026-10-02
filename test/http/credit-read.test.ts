import type { FastifyInstance } from "fastify";
import { billingHeaderCount } from "../../src/infrastructure/auth/billing-identity-header.js";
import type { Server } from "node:http";
import type { generateKeyPair } from "jose";
import type { BillingSchemaValidator } from "../../src/infrastructure/auth/billing-auth.types.js";
import type { ErrorResponse } from "../../src/generated/billing-api/types.gen.js";
import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { BillingHttpModule } from "../../src/http/billing-http.module.js";
import { CreditService } from "../../src/modules/credit/credit.service.js";

@Controller("__r73_registration_control")
class R73RegistrationControlController {
  @Get()
  control(): Readonly<{ ready: true }> {
    return { ready: true };
  }
}

describe("R73 personal Credit HTTP registration prerequisite only", () => {
  it.each(["/v2/billing/me/credit-account", "/v2/billing/me/credit-ledger"])(
    "registers %s after a real Nest adapter control",
    async (path) => {
      const readDouble: Pick<CreditService, "getMyAccount" | "listMyLedger"> = {
        getMyAccount: vi.fn<CreditService["getMyAccount"]>(() =>
          Promise.resolve({
            id: "11111111-1111-4111-8111-111111111111",
            tenantId: "tenant-a",
            subjectId: "subject-a",
            status: "active",
            availableMicros: 9_007_199_254_740_993n,
            heldMicros: 0n,
          }),
        ),
        listMyLedger: vi.fn<CreditService["listMyLedger"]>(() =>
          Promise.resolve({ items: [], nextCursor: null }),
        ),
      };
      const moduleRef = await Test.createTestingModule({
        imports: [
          DatabaseModule.register({
            databaseUrl: "postgresql://unused.invalid/r73_never_connected",
          }),
          BillingHttpModule.register({
            mode: "jwks",
            internalServiceSecret: "r74-fixture-service-secret-0000000001",
            bffServiceToken: "r74-fixture-bff-token-000000000000001",
            operatorProxySecret: "r74-fixture-operator-secret-000000001",
            jwksUrl: "http://127.0.0.1:1/unused-bff-jwks",
            issuer: "r74-iam",
            audience: "r74-billing",
          }),
        ],
        controllers: [R73RegistrationControlController],
      })
        // The production module graph is retained, but no Prisma constructor,
        // lifecycle, transaction, database socket or business read runs here.
        .overrideProvider(PrismaService)
        .useValue({})
        .overrideProvider(TransactionService)
        .useValue({})
        .overrideProvider(CreditService)
        .useValue(readDouble)
        .compile();
      const adapter = new FastifyAdapter({ logger: false });
      const app =
        moduleRef.createNestApplication<NestFastifyApplication>(adapter);
      try {
        await app.init();
        await adapter.getInstance().ready();
        expect(app.get<CreditService>(CreditService)).toBe(readDouble);
        const control = await app.inject({
          method: "GET",
          url: "/__r73_registration_control",
        });
        expect(control.statusCode).toBe(200);
        expect(control.json<unknown>()).toEqual({ ready: true });
        expect(readDouble.getMyAccount).not.toHaveBeenCalled();
        expect(readDouble.listMyLedger).not.toHaveBeenCalled();

        const response = await app.inject({
          method: "GET",
          url: path,
          headers: {
            "x-kokoro-tenant-id": "u1.dGVuYW50LWE",
            "x-kokoro-subject": "u1.c3ViamVjdC1h",
            "x-kokoro-service": "web-bff",
            "x-kokoro-internal-secret": "r74-fixture-service-secret-0000000001",
            authorization: "Bearer r74-fixture-bff-token-000000000000001",
          },
        });
        // The original registration assertions remain; deep R74 assertions follow separately.
        expect(
          response.statusCode,
          "personal route registration prerequisite",
        ).toBe(200);
      } finally {
        await app.close();
      }
    },
  );
});

// R74 full HTTP matrix. JWKS is a local real RS256 fixture; all personal
// requests use the production Controller/Guard/Filter/module, never a fake route.
describe("R74 production personal Credit HTTP", () => {
  const accountPath = "/v2/billing/me/credit-account";
  const ledgerPath = "/v2/billing/me/credit-ledger";
  const encode = (value: string) =>
    "u1." + Buffer.from(value, "utf8").toString("base64url");
  const profile = {
    mode: "jwks" as const,
    internalServiceSecret: "r74-fixture-service-secret-0000000001",
    bffServiceToken: "r74-fixture-bff-token-000000000000001",
    operatorProxySecret: "r74-fixture-operator-secret-000000001",
    issuer: "r74-iam",
    audience: "r74-billing",
  };
  const machine = (
    tenant = "tenant-a",
    subject = "subject-a",
  ): Record<string, string> => ({
    "x-kokoro-service": "web-bff",
    "x-kokoro-internal-secret": profile.internalServiceSecret,
    authorization: `Bearer ${profile.bffServiceToken}`,
    "x-kokoro-tenant-id": encode(tenant),
    "x-kokoro-subject": encode(subject),
    "x-request-id": "r74-request.control-1",
  });
  const snapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant-a",
    subjectId: "subject-a",
    status: "active",
    availableMicros: 9_007_199_254_740_993n,
    heldMicros: 0n,
  };
  const reads = {
    getMyAccount: vi.fn<CreditService["getMyAccount"]>(),
    listMyLedger: vi.fn<CreditService["listMyLedger"]>(),
  };
  let app: NestFastifyApplication;
  let jwksServer: Server;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let schemas: BillingSchemaValidator;
  let jwt: string;
  let cardinality:
    | {
        header: string;
        originalRawNames: string[];
        rawNames: string[];
        rawCount: number;
        normalizedCount: number;
        folded: boolean;
      }
    | undefined;
  const clear = () => {
    reads.getMyAccount.mockClear();
    reads.listMyLedger.mockClear();
  };
  const noRead = () => {
    expect(reads.getMyAccount).not.toHaveBeenCalled();
    expect(reads.listMyLedger).not.toHaveBeenCalled();
  };
  async function control() {
    expect(
      (
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: machine(),
        })
      ).statusCode,
    ).toBe(200);
    clear();
  }
  function check(
    response: Awaited<ReturnType<NestFastifyApplication["inject"]>>,
    status: number,
    code?: string,
  ) {
    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(
      /^[A-Za-z0-9._:-]{1,255}$/u,
    );
    expect(response.headers["x-kokoro-request-id"]).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    if (code !== undefined) {
      const body = response.json<ErrorResponse>();
      schemas.assert("ErrorResponse", body);
      expect(body.error.code).toBe(code);
      expect(body.error.retryable).toBe(status === 503);
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual([
        "code",
        "message",
        "retryable",
      ]);
      expect(response.body).not.toContain("PRIVATE_DB_DETAIL");
      expect(response.body).not.toContain(profile.internalServiceSecret);
      expect(response.body).not.toContain(profile.bffServiceToken);
    }
  }
  beforeAll(async () => {
    const { createServer } = await import("node:http");
    const { generateKeyPair, exportJWK } = await import("jose");
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    jwksServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...jwk, kid: "r74-http", alg: "RS256", use: "sig" }],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      jwksServer.listen(0, "127.0.0.1", resolve),
    );
    const address = jwksServer.address();
    if (address === null || typeof address === "string")
      throw new Error("JWKS fixture not bound");
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({
          databaseUrl: "postgresql://unused.invalid/r74_never_connected",
        }),
        BillingHttpModule.register({
          ...profile,
          jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
        }),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(TransactionService)
      .useValue({})
      .overrideProvider(CreditService)
      .useValue(reads)
      .compile();
    const adapter = new FastifyAdapter({ logger: false });
    adapter
      .getInstance<FastifyInstance>()
      .addHook("onRequest", (request, reply, done) => {
        expect(reply.sent).toBe(false);
        const name = request.headers["x-r76-observe-header"];
        if (
          typeof name === "string" &&
          [
            "authorization",
            "x-kokoro-service",
            "x-kokoro-internal-secret",
            "x-kokoro-tenant-id",
            "x-kokoro-subject",
          ].includes(name)
        ) {
          const originalRawNames = request.raw.rawHeaders.filter(
            (value, index) => index % 2 === 0 && value.toLowerCase() === name,
          );
          // Only raw-name casing changes; occurrence count and all values remain native.
          for (let index = 0; index < request.raw.rawHeaders.length; index += 2)
            if (request.raw.rawHeaders[index]?.toLowerCase() === name)
              request.raw.rawHeaders[index] = name.toUpperCase();
          cardinality = {
            header: name,
            originalRawNames,
            rawNames: request.raw.rawHeaders.filter(
              (value, index) => index % 2 === 0 && value.toLowerCase() === name,
            ),
            rawCount: billingHeaderCount(request.raw.rawHeaders, name),
            normalizedCount: billingHeaderCount(
              request.raw.rawHeaders.map((value, index) =>
                index % 2 === 0 ? value.toLowerCase() : value,
              ),
              name,
            ),
            folded:
              typeof request.headers[name] === "string" &&
              request.headers[name].includes(","),
          };
        }
        done();
      });
    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    await app.init();
    await adapter.getInstance().ready();
    const { BILLING_SCHEMA_VALIDATOR } =
      await import("../../src/infrastructure/auth/billing-auth.types.js");
    schemas = app.get(BILLING_SCHEMA_VALIDATOR);
    jwt = await sign();
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve, reject) =>
      jwksServer.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    reads.getMyAccount.mockReset().mockResolvedValue(snapshot);
    reads.listMyLedger
      .mockReset()
      .mockResolvedValue({ items: [], nextCursor: null });
  });
  async function sign(
    patch: {
      tenant?: string;
      subject?: string;
      issuer?: string;
      audience?: string;
      expires?: number;
    } = {},
  ) {
    const { SignJWT } = await import("jose");
    return new SignJWT({ tenant_id: patch.tenant ?? "tenant-a" })
      .setSubject(patch.subject ?? "subject-a")
      .setProtectedHeader({ alg: "RS256", kid: "r74-http" })
      .setIssuer(patch.issuer ?? profile.issuer)
      .setAudience(patch.audience ?? profile.audience)
      .setIssuedAt()
      .setExpirationTime(patch.expires ?? Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
  }
  it("compiles the closed 43-schema registry, rejects mutation/coercion and unknown UTC/nonnullable fields", () => {
    expect(schemas.names).toHaveLength(43);
    const valid = {
      data: {
        credit_account_id: snapshot.id,
        status: "active",
        available_micros: "9007199254740993",
        held_micros: "0",
      },
    };
    schemas.assert("CreditAccountResponse", valid);
    for (const value of [
      { ...valid, meta: {} },
      { data: { ...valid.data, available_micros: 10 } },
      { data: { ...valid.data, extra: true } },
      { data: { ...valid.data, held_micros: null } },
    ]) {
      const before = structuredClone(value);
      expect(() => schemas.assert("CreditAccountResponse", value)).toThrow();
      expect(value).toEqual(before);
    }
    const entry = {
      journal_id: snapshot.id,
      sequence: "1",
      delta_micros: "-1",
      balance_after_micros: "0",
      source_kind: "fixture",
      source_ref: "fixture",
      created_at: "2026-01-02T03:04:05.006Z",
    };
    schemas.assert("CreditLedgerResponse", {
      data: { items: [entry], page: { next_cursor: null } },
    });
    expect(() =>
      schemas.assert("CreditLedgerResponse", {
        data: {
          items: [{ ...entry, created_at: "2026-01-02T03:04:05+00:00" }],
          page: { next_cursor: null },
        },
      }),
    ).toThrow();
  });
  it("maps exact bigint/UTC fields, signed delta and passes opaque cursor unchanged", async () => {
    await control();
    const account = await app.inject({
      method: "GET",
      url: accountPath,
      headers: machine(),
    });
    check(account, 200);
    schemas.assert("CreditAccountResponse", account.json<unknown>());
    expect(account.json<unknown>()).toEqual({
      data: {
        credit_account_id: snapshot.id,
        status: "active",
        available_micros: "9007199254740993",
        held_micros: "0",
      },
    });
    expect(reads.getMyAccount).toHaveBeenCalledExactlyOnceWith({
      tenantId: "tenant-a",
      subjectId: "subject-a",
    });
    reads.listMyLedger.mockResolvedValue({
      items: [
        {
          journalId: snapshot.id,
          sequence: 9_007_199_254_740_993n,
          deltaMicros: -9_007_199_254_740_993n,
          balanceAfterMicros: 0n,
          sourceKind: "fixture",
          sourceRef: "fixture-a",
          createdAt: new Date("2026-01-02T03:04:05.006Z"),
        },
      ],
      nextCursor: "opaque-next",
    });
    const ledger = await app.inject({
      method: "GET",
      url: ledgerPath + "?limit=100&cursor=opaque-token",
      headers: machine(),
    });
    check(ledger, 200);
    schemas.assert("CreditLedgerResponse", ledger.json<unknown>());
    expect(ledger.json<unknown>()).toEqual({
      data: {
        items: [
          {
            journal_id: snapshot.id,
            sequence: "9007199254740993",
            delta_micros: "-9007199254740993",
            balance_after_micros: "0",
            source_kind: "fixture",
            source_ref: "fixture-a",
            created_at: "2026-01-02T03:04:05.006Z",
          },
        ],
        page: { next_cursor: "opaque-next" },
      },
    });
    expect(reads.listMyLedger).toHaveBeenCalledExactlyOnceWith(
      { tenantId: "tenant-a", subjectId: "subject-a" },
      { limit: 100, cursor: "opaque-token" },
    );
  });
  it("reads disabled/empty without treating absent account as an empty page", async () => {
    await control();
    reads.getMyAccount.mockResolvedValue({ ...snapshot, status: "disabled" });
    const disabled = await app.inject({
      method: "GET",
      url: accountPath,
      headers: machine(),
    });
    check(disabled, 200);
    expect(disabled.json<{ data: { status: string } }>().data.status).toBe(
      "disabled",
    );
    const empty = await app.inject({
      method: "GET",
      url: ledgerPath,
      headers: machine(),
    });
    check(empty, 200);
    expect(empty.json<unknown>()).toEqual({
      data: { items: [], page: { next_cursor: null } },
    });
    expect(reads.listMyLedger).toHaveBeenCalledExactlyOnceWith(
      { tenantId: "tenant-a", subjectId: "subject-a" },
      { limit: 50 },
    );
    reads.getMyAccount.mockResolvedValue(null);
    check(
      await app.inject({ method: "GET", url: accountPath, headers: machine() }),
      404,
      "billing.not_found",
    );
  });
  it.each([
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "x-kokoro-subject",
    "authorization",
    "x-kokoro-tenant-id",
  ])("rejects missing/empty machine factor %s before reads", async (name) => {
    await control();
    for (const empty of [false, true]) {
      const headers = machine();
      if (empty) headers[name] = "";
      else delete headers[name];
      check(
        await app.inject({ method: "GET", url: accountPath, headers }),
        403,
        "billing.forbidden",
      );
      noRead();
    }
  });
  it.each(["x-kokoro-service", "x-kokoro-internal-secret", "x-kokoro-subject"])(
    "never downgrades empty marker %s to a valid JWT",
    async (name) => {
      await control();
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: {
            authorization: `Bearer ${jwt}`,
            "x-kokoro-tenant-id": encode("tenant-a"),
            [name]: "",
          },
        }),
        403,
        "billing.forbidden",
      );
      noRead();
    },
  );
  it.each(["x-kokoro-service", "x-kokoro-internal-secret", "authorization"])(
    "rejects wrong/repeated credential %s before reads",
    async (name) => {
      await control();
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: { ...machine(), [name]: "wrong" },
        }),
        403,
        "billing.forbidden",
      );
      noRead();
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: {
            ...machine(),
            [name]: [machine()[name] ?? "", machine()[name] ?? ""],
          },
        }),
        403,
        "billing.forbidden",
      );
      noRead();
    },
  );
  it("dedicated service Bearer alone selects forbidden machine rather than JWT", async () => {
    await control();
    check(
      await app.inject({
        method: "GET",
        url: accountPath,
        headers: {
          authorization: `Bearer ${profile.bffServiceToken}`,
          "x-kokoro-tenant-id": encode("tenant-a"),
        },
      }),
      403,
      "billing.forbidden",
    );
    noRead();
  });
  it.each(["x-kokoro-tenant-id", "x-kokoro-subject"])(
    "rejects malformed/duplicate identity %s before reads",
    async (name) => {
      await control();
      for (const value of [
        "raw-identity",
        "%69dentity",
        "u1.aQ=",
        "u1.aR",
        "u1._w",
        "u1.7aCA",
        "u1.AA",
        "u1.aQ, u1.aQ",
        [encode("i"), encode("i")],
      ]) {
        check(
          await app.inject({
            method: "GET",
            url: accountPath,
            headers: { ...machine(), [name]: value },
          }),
          400,
          "billing.invalid_request",
        );
        noRead();
      }
    },
  );
  it.each(["tenant", "subject"] as const)(
    "preserves %s maximum/BOM/space/NFD/NFC without normalization",
    async (kind) => {
      await control();
      for (const value of [
        "😀".repeat(kind === "tenant" ? 191 : 255),
        "\uFEFFidentity-a",
        " identity-a ",
        "e\u0301",
        "é",
      ]) {
        clear();
        const tenant = kind === "tenant" ? value : "tenant-a";
        const subject = kind === "subject" ? value : "subject-a";
        check(
          await app.inject({
            method: "GET",
            url: accountPath,
            headers: machine(tenant, subject),
          }),
          200,
        );
        expect(reads.getMyAccount).toHaveBeenCalledExactlyOnceWith({
          tenantId: tenant,
          subjectId: subject,
        });
      }
    },
  );
  it("verifies real JWT and binds tenant; arbitrary Authorization is not a machine marker", async () => {
    await control();
    check(
      await app.inject({
        method: "GET",
        url: accountPath,
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-kokoro-tenant-id": encode("tenant-a"),
        },
      }),
      200,
    );
    expect(reads.getMyAccount).toHaveBeenCalledExactlyOnceWith({
      tenantId: "tenant-a",
      subjectId: "subject-a",
    });
    clear();
    for (const headers of [
      {},
      { "x-kokoro-tenant-id": encode("tenant-a") },
      {
        authorization: "Bearer arbitrary",
        "x-kokoro-tenant-id": encode("tenant-a"),
      },
    ]) {
      check(
        await app.inject({ method: "GET", url: accountPath, headers }),
        401,
        "billing.unauthenticated",
      );
      noRead();
    }
    for (const tenant of [undefined, "", encode("tenant-b")]) {
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: {
            authorization: `Bearer ${jwt}`,
            ...(tenant === undefined ? {} : { "x-kokoro-tenant-id": tenant }),
          },
        }),
        403,
        "billing.forbidden",
      );
      noRead();
    }
    check(
      await app.inject({
        method: "GET",
        url: accountPath,
        headers: {
          authorization: `Bearer ${jwt}`,
          "x-kokoro-tenant-id": "tenant-a",
        },
      }),
      400,
      "billing.invalid_request",
    );
    noRead();
  });
  it.each([
    { issuer: "wrong" },
    { audience: "wrong" },
    { expires: 1 },
    { subject: "" },
    { subject: "x\0y" },
    { subject: "\uD800" },
    { subject: "😀".repeat(256) },
    { tenant: "😀".repeat(192) },
  ])("rejects verified invalid JWT case %# before reads", async (patch) => {
    await control();
    check(
      await app.inject({
        method: "GET",
        url: accountPath,
        headers: {
          authorization: `Bearer ${await sign(patch)}`,
          "x-kokoro-tenant-id": encode("tenant-a"),
        },
      }),
      401,
      "billing.unauthenticated",
    );
    noRead();
  });
  it("rejects a real signed JWT without expiration rather than accepting an unbounded session", async () => {
    await control();
    const { SignJWT } = await import("jose");
    const unbounded = await new SignJWT({ tenant_id: "tenant-a" })
      .setSubject("subject-a")
      .setProtectedHeader({ alg: "RS256", kid: "r74-http" })
      .setIssuer(profile.issuer)
      .setAudience(profile.audience)
      .sign(privateKey);
    for (const path of [accountPath, ledgerPath]) {
      check(
        await app.inject({
          method: "GET",
          url: path,
          headers: {
            authorization: `Bearer ${unbounded}`,
            "x-kokoro-tenant-id": encode("tenant-a"),
          },
        }),
        401,
        "billing.unauthenticated",
      );
      noRead();
    }
  });
  it.each([
    "limit=",
    "limit=0",
    "limit=101",
    "limit=01",
    "limit=1e1",
    "limit=1.0",
    "limit=-1",
    "limit=%2B1",
    "limit=%201",
    "limit=1%20",
    "limit=1&limit=2",
    "limit[]=1",
    "cursor=",
    "cursor=a&cursor=b",
    "subject_id=foreign",
    "account_id=foreign",
    "extra=x",
    "cursor=" + "a".repeat(2049),
  ])("rejects closed ledger query %s before reads", async (query) => {
    await control();
    check(
      await app.inject({
        method: "GET",
        url: ledgerPath + "?" + query,
        headers: machine(),
      }),
      400,
      "billing.invalid_request",
    );
    noRead();
  });
  it("rejects account queries, valid/malformed JSON GET bodies and checks auth first", async () => {
    await control();
    check(
      await app.inject({
        method: "GET",
        url: accountPath + "?limit=1",
        headers: machine(),
      }),
      400,
      "billing.invalid_request",
    );
    noRead();
    for (const payload of ["{}", "null", "{bad"]) {
      check(
        await app.inject({
          method: "GET",
          url: ledgerPath,
          headers: { ...machine(), "content-type": "application/json" },
          payload,
        }),
        400,
        "billing.invalid_request",
      );
      noRead();
    }
    check(
      await app.inject({ method: "GET", url: ledgerPath + "?limit=bad" }),
      401,
      "billing.unauthenticated",
    );
    noRead();
  });
  it.each(["/not-a-route", accountPath])(
    "protects unmatched/wrong-method route %s with headers and stable error",
    async (path) => {
      await control();
      check(
        await app.inject({ method: "POST", url: path, headers: machine() }),
        404,
        "billing.not_found",
      );
      noRead();
    },
  );
  it("rebuilds invalid or repeated request IDs and propagates only the controlled ID", async () => {
    await control();
    for (const id of ["bad id", "a".repeat(256), ["first", "second"]]) {
      const result = await app.inject({
        method: "GET",
        url: accountPath,
        headers: { ...machine(), "x-request-id": id },
      });
      check(result, 200);
      expect(result.headers["x-request-id"]).toMatch(/^[a-f0-9-]{36}$/u);
    }
    const result = await app.inject({
      method: "GET",
      url: accountPath,
      headers: machine(),
    });
    check(result, 200);
    expect(result.headers["x-request-id"]).toBe("r74-request.control-1");
  });
  it("preserves real JWT identities and rejects repeated or uppercase identity headers", async () => {
    await control();
    for (const identity of [
      { tenant: "😀".repeat(191), subject: "🦊".repeat(255) },
      { tenant: "\uFEFFtenant", subject: "\uFEFFsubject" },
      { tenant: " tenant ", subject: " subject " },
      { tenant: "e\u0301", subject: "e\u0301" },
      { tenant: "é", subject: "é" },
    ]) {
      clear();
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: {
            authorization: `Bearer ${await sign(identity)}`,
            "x-kokoro-tenant-id": encode(identity.tenant),
          },
        }),
        200,
      );
      expect(reads.getMyAccount).toHaveBeenCalledExactlyOnceWith({
        tenantId: identity.tenant,
        subjectId: identity.subject,
      });
    }
    clear();
    const repeatedHeaders: Array<Record<string, string | string[]>> = [
      {
        authorization: [`Bearer ${jwt}`, `Bearer ${jwt}`],
        "x-kokoro-tenant-id": encode("tenant-a"),
      },
      {
        authorization: `Bearer ${jwt}`,
        "x-kokoro-tenant-id": [encode("tenant-a"), encode("tenant-a")],
      },
    ];
    for (const repeated of repeatedHeaders) {
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: repeated,
        }),
        Array.isArray(repeated.authorization) ? 401 : 400,
        Array.isArray(repeated.authorization)
          ? "billing.unauthenticated"
          : "billing.invalid_request",
      );
      noRead();
    }
    const uppercase = machine();
    delete uppercase["x-kokoro-subject"];
    check(
      await app.inject({
        method: "GET",
        url: accountPath,
        headers: {
          ...uppercase,
          "X-Kokoro-Subject": [encode("subject-a"), encode("subject-a")],
        },
      }),
      400,
      "billing.invalid_request",
    );
    noRead();
  });
  it.each([
    "authorization",
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "x-kokoro-tenant-id",
    "x-kokoro-subject",
  ])(
    "R76 rejects actual folded duplicate %s and raw-name casing without inventing wire factors",
    async (name) => {
      await control();
      for (const path of [accountPath, ledgerPath]) {
        cardinality = undefined;
        const value = machine()[name];
        if (value === undefined) throw new Error("Missing fixture header");
        check(
          await app.inject({
            method: "GET",
            url: path,
            headers: {
              ...machine(),
              [name]: [value, value],
              "x-r76-observe-header": name,
            },
          }),
          name === "x-kokoro-tenant-id" || name === "x-kokoro-subject"
            ? 400
            : 403,
          name === "x-kokoro-tenant-id" || name === "x-kokoro-subject"
            ? "billing.invalid_request"
            : "billing.forbidden",
        );
        noRead();
        expect(cardinality).toEqual({
          header: name,
          originalRawNames: [name],
          rawNames: [name.toUpperCase()],
          rawCount: 1,
          normalizedCount: 1,
          folded: true,
        });
        // Counts/names only: never output credentials or wire identity contents.
        process.stdout.write(
          "R76 observed header cardinality " +
            JSON.stringify(cardinality) +
            "\n",
        );
      }
    },
  );
  it("maps typed failures only, hides internal details, and recovers on next request", async () => {
    const { CreditError } =
      await import("../../src/modules/credit/credit.error.js");
    const { TransactionContextError } =
      await import("../../src/database/transaction.error.js");
    const { Prisma } = await import("../../src/generated/prisma/client.js");
    const { DatabaseError } = await import("pg");
    const native = new DatabaseError("PRIVATE_DB_DETAIL", 0, "error");
    native.code = "57014";
    const errors: Array<readonly [unknown, number, string]> = [
      [
        new CreditError("CREDIT_INVALID_CURSOR", "PRIVATE_DB_DETAIL"),
        400,
        "billing.invalid_request",
      ],
      [
        new CreditError("CREDIT_ACCOUNT_NOT_FOUND", "PRIVATE_DB_DETAIL"),
        404,
        "billing.not_found",
      ],
      [
        new CreditError("CREDIT_READ_CORRUPT", "PRIVATE_DB_DETAIL"),
        500,
        "billing.internal_error",
      ],
      [
        new TransactionContextError("DATABASE_NOT_READY", "PRIVATE_DB_DETAIL"),
        503,
        "billing.dependency_unavailable",
      ],
      [
        new Prisma.PrismaClientKnownRequestError("PRIVATE_DB_DETAIL", {
          code: "P1001",
          clientVersion: "fixture",
        }),
        503,
        "billing.dependency_unavailable",
      ],
      [
        new Prisma.PrismaClientKnownRequestError("PRIVATE_DB_DETAIL", {
          code: "P2028",
          clientVersion: "fixture",
        }),
        500,
        "billing.internal_error",
      ],
      [
        new Prisma.PrismaClientKnownRequestError("PRIVATE_DB_DETAIL", {
          code: "P2010",
          clientVersion: "fixture",
          meta: {
            driverAdapterError: {
              cause: { originalCode: "55P03" },
            },
          },
        }),
        503,
        "billing.dependency_unavailable",
      ],
      [
        new Prisma.PrismaClientKnownRequestError("PRIVATE_DB_DETAIL", {
          code: "P2010",
          clientVersion: "fixture",
          meta: {
            driverAdapterError: {
              cause: { originalCode: "23505" },
            },
          },
        }),
        500,
        "billing.internal_error",
      ],
      [
        new AggregateError([native], "PRIVATE_DB_DETAIL", { cause: native }),
        503,
        "billing.dependency_unavailable",
      ],
      [native, 503, "billing.dependency_unavailable"],
      [new Error("timeout PRIVATE_DB_DETAIL"), 500, "billing.internal_error"],
      [
        { code: "P1001", message: "PRIVATE_DB_DETAIL" },
        500,
        "billing.internal_error",
      ],
    ];
    for (const [error, status, code] of errors) {
      await control();
      reads.getMyAccount.mockRejectedValueOnce(error);
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: machine(),
        }),
        status,
        code,
      );
      expect(reads.getMyAccount).toHaveBeenCalledTimes(1);
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: machine(),
        }),
        200,
      );
    }
  });
  it.each([
    { ...snapshot, availableMicros: -1n },
    { ...snapshot, status: "unknown" },
    { ...snapshot, id: "not-uuid" },
    { ...snapshot, heldMicros: 1 as unknown as bigint },
  ])(
    "rejects corrupt response %# instead of returning success",
    async (value) => {
      await control();
      reads.getMyAccount.mockResolvedValueOnce(value);
      check(
        await app.inject({
          method: "GET",
          url: accountPath,
          headers: machine(),
        }),
        500,
        "billing.internal_error",
      );
    },
  );
  it("rejects internal-header, missing audience and weak/unbound config at assembly", async () => {
    const { readBillingPersonalHttpOptions } =
      await import("../../src/config/runtime-config.js");
    const complete = { ...profile, jwksUrl: "http://127.0.0.1:1/jwks" };
    for (const invalid of [
      { ...complete, mode: "internal-header" as const },
      { ...complete, audience: "" },
      { ...complete, internalServiceSecret: "weak" },
      { ...complete, operatorProxySecret: complete.internalServiceSecret },
    ]) {
      expect(() => BillingHttpModule.register(invalid)).toThrow();
    }
    expect(() =>
      readBillingPersonalHttpOptions({
        BILLING_AUTH_MODE: "jwks",
        INTERNAL_SERVICE_SECRET: profile.internalServiceSecret,
        BILLING_OPERATOR_PROXY_SECRET: profile.operatorProxySecret,
        BILLING_AUTH_JWKS_URL: complete.jwksUrl,
        BILLING_AUTH_JWT_ISSUER: profile.issuer,
        BILLING_AUTH_JWT_AUDIENCE: profile.audience,
        // Historical upstreamSecret/serviceToken may not substitute the dedicated BFF key.
        UPSTREAM_SECRET: profile.bffServiceToken,
        SERVICE_TOKEN: profile.bffServiceToken,
      }),
    ).toThrow("BILLING_BFF_SERVICE_TOKEN");
  });
});
