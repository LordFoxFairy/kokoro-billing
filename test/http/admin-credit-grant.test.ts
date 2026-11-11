import "reflect-metadata";
import { request as httpRequest, Server } from "node:http";
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
import { AppModule } from "../../src/app.module.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";
import { CreditError } from "../../src/modules/credit/credit.error.js";
import { CommandReceiptError } from "../../src/database/command-receipt.error.js";
import { CreditService } from "../../src/modules/credit/credit.service.js";

const auth = {
  internal: "funding-internal-secret-000000000001",
  bearer: "funding-bff-bearer-token-00000000001",
  operator: "funding-operator-secret-000000000001",
};
const path = "/v1/admin/billing/credit-grants";
const body = {
  funding_id: "11111111-1111-4111-8111-111111111111",
  subject_id: "recipient-a",
  amount_credits: "1000",
  reason: "Non-cash acceptance credits",
  effective_at: "2026-10-01T00:00:00.000Z",
};
const result = {
  accountId: "22222222-2222-4222-8222-222222222222",
  grantId: "33333333-3333-4333-8333-333333333333",
  journalId: "44444444-4444-4444-8444-444444444444",
};
const headers = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${auth.bearer}`,
  "x-kokoro-service": "web-bff",
  "x-kokoro-internal-secret": auth.internal,
  "x-kokoro-proxy-secret": auth.operator,
  "x-kokoro-tenant-id": "u1." + Buffer.from("tenant-a").toString("base64url"),
  "x-kokoro-subject": "u1." + Buffer.from("operator-a").toString("base64url"),
  "idempotency-key": "funding-key-1",
});
describe("administrative non-cash whole-credit issuance HTTP", () => {
  let app: NestFastifyApplication;
  const grant = vi.fn(() => Promise.resolve(result));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        AppModule.register(
          readBillingRuntimeConfig({
            DATABASE_URL:
              "postgresql://unused@localhost/unused?schema=kokoro_billing",
            BILLING_AUTH_MODE: "jwks",
            BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
            BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
            BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
            INTERNAL_SERVICE_SECRET: auth.internal,
            BILLING_BFF_SERVICE_TOKEN: auth.bearer,
            BILLING_OPERATOR_PROXY_SECRET: auth.operator,
          }),
        ),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({
        ping: () => Promise.resolve(),
        clientForDatabaseInfrastructure: () => ({}),
      })
      .overrideProvider(CreditService)
      .useValue({ grant })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    grant.mockReset();
    grant.mockResolvedValue(result);
  });
  it("converts whole Credits exactly and binds the authenticated operator and permanent funding identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: headers(),
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: {
        account_id: result.accountId,
        grant_id: result.grantId,
        journal_id: result.journalId,
      },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(grant).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "operator-a",
      subjectId: body.subject_id,
      amountMicros: 1_000_000_000n,
      idempotencyKey: "funding-key-1",
      commandIdentity: body.funding_id,
      sourceKind: "admin_credit",
      sourceRef: body.funding_id,
      programKey: "admin_credit_v1",
      reason: body.reason,
      effectiveAt: new Date(body.effective_at),
    });
  });
  for (const field of [
    "authorization",
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "x-kokoro-proxy-secret",
    "x-kokoro-tenant-id",
    "x-kokoro-subject",
  ] as const) {
    it(`rejects missing ${field} without touching funds`, async () => {
      const input: Record<string, string> = headers();
      delete input[field];
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: input,
        payload: body,
      });
      expect(response.statusCode).toBe(403);
      expect(grant).not.toHaveBeenCalled();
    });
  }
  it.each([
    { authorization: "Bearer untrusted-user-token" },
    { "x-kokoro-internal-secret": "wrong-service-capability" },
    { "x-kokoro-proxy-secret": auth.internal },
    { "x-kokoro-service": "admin", "x-kokoro-role": "billing.admin" },
    { "x-kokoro-tenant-id": "tenant-a" },
    { "x-kokoro-subject": "operator-a" },
    { "x-kokoro-subject": "u1.b3BlcmF0b3ItYQ==" },
  ])("rejects credential/identity substitution %#", async (patch) => {
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers(), ...patch },
      payload: body,
    });
    expect(response.statusCode).toBe(403);
    expect(grant).not.toHaveBeenCalled();
  });
  it.each([
    { amount_credits: "0" },
    { amount_credits: "-1" },
    { amount_credits: "1.1" },
    { amount_credits: "1e3" },
    { amount_credits: "01" },
    { amount_credits: " 1" },
    { amount_credits: "9223372036855" },
    { amount_credits: 1000 },
    { reason: "   " },
    { reason: "nul\0" },
    { reason: "bad\ud800" },
    { subject_id: "bad\udfff" },
    { subject_id: "nul\0" },
    { funding_id: "another-command" },
    { effective_at: "2026-02-30T00:00:00.000Z" },
    { effective_at: "2026-10-01T00:00:00Z" },
    { effective_at: "0000-01-01T00:00:00.000Z" },
    { tenant_id: "foreign" },
    { actor_id: "someone" },
    { source_kind: "payment" },
    { balance: "9999" },
  ])(
    "rejects noncanonical or self-reported intent %# before funding",
    async (patch) => {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: headers(),
        payload: { ...body, ...patch },
      });
      expect(response.statusCode).toBe(400);
      expect(grant).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate decoded JSON names, invalid UTF-8 and oversized bodies", async () => {
    const compact = JSON.stringify(body);
    const payloads = [
      compact.replace(
        '"amount_credits":"1000"',
        '"amount_credits":"1","amount_credits":"1000"',
      ),
      compact.replace('"reason":', '"\\u0072eason":"duplicate","reason":'),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x22, 0x78, 0x22, 0x7d]),
      JSON.stringify({ ...body, reason: "x".repeat(16385) }),
      "null",
      "[]",
    ];
    for (const payload of payloads) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: headers(),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(grant).not.toHaveBeenCalled();
  });
  it("keeps query/MIME/idempotency framing out of the funding command", async () => {
    for (const request of [
      { url: path + "?tenant_id=foreign", headers: headers() },
      { url: path, headers: { ...headers(), "content-type": "text/plain" } },
      { url: path, headers: { ...headers(), "idempotency-key": "short" } },
      {
        url: path,
        headers: {
          ...headers(),
          "x-kokoro-proxy-secret": [auth.operator, auth.operator],
        },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        ...request,
        payload: JSON.stringify(body),
      });
      expect([400, 403]).toContain(response.statusCode);
    }
    expect(grant).not.toHaveBeenCalled();
  });
  it("rejects genuinely repeated command/privilege headers on a real HTTP socket", async () => {
    await app.listen(0, "127.0.0.1");
    const server: unknown = app.getHttpServer();
    if (!(server instanceof Server))
      throw new Error("Owned HTTP server missing");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Owned HTTP listener missing");
    for (const [name, values] of [
      ["idempotency-key", ["funding-key-1", "funding-key-2"]],
      ["x-kokoro-proxy-secret", [auth.operator, auth.operator]],
    ] as const) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method: "POST",
            headers: { ...headers(), [name]: [...values] },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.setTimeout(2000, () =>
          request.destroy(new Error("Owned HTTP request deadline")),
        );
        request.once("error", reject);
        request.end(JSON.stringify(body));
      });
      expect(status).toBe(name === "idempotency-key" ? 400 : 403);
    }
    expect(grant).not.toHaveBeenCalled();
  });
  it("supports exact large integer conversion and Unicode identities", async () => {
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: {
        ...headers(),
        "x-kokoro-tenant-id":
          "u1." + Buffer.from("租户😀").toString("base64url"),
        "x-kokoro-subject":
          "u1." + Buffer.from("管理者😀").toString("base64url"),
      },
      payload: {
        ...body,
        subject_id: "接收者😀",
        amount_credits: "9223372036854",
        reason: "测试额度😀",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "租户😀",
        actorId: "管理者😀",
        subjectId: "接收者😀",
        amountMicros: 9_223_372_036_854_000_000n,
      }),
    );
  });
  it.each([
    new CreditError("CREDIT_IDEMPOTENCY_CONFLICT", "private funding intent"),
    new CommandReceiptError(
      "COMMAND_IDEMPOTENCY_CONFLICT",
      "private original command",
    ),
  ])("maps only typed intent conflicts to nonretryable409", async (error) => {
    grant.mockRejectedValueOnce(error);
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: headers(),
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "billing.idempotency_conflict", retryable: false },
    });
    expect(response.body).not.toContain("private");
  });
  it("preserves corrupt or failed funding as failure instead of inventing a successful grant", async () => {
    grant.mockRejectedValueOnce(
      new CommandReceiptError(
        "COMMAND_RECEIPT_CORRUPT",
        "private corrupt receipt",
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: headers(),
      payload: body,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private");
  });
});
