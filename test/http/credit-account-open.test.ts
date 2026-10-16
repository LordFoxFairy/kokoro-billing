import "reflect-metadata";
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
import { CreditService } from "../../src/modules/credit/credit.service.js";
import { CreditError } from "../../src/modules/credit/credit.error.js";
const auth = {
  mode: "jwks" as const,
  internalServiceSecret: "opening-internal-secret-00000000001",
  bffServiceToken: "opening-bff-service-token-000000001",
  operatorProxySecret: "opening-operator-secret-00000000001",
  jwksUrl: "https://iam.example.test/iam/jwks",
  issuer: "https://iam.example.test/iam",
  audience: "https://kokoro.dev/resources/billing",
};
const path = "/v2/billing/me/credit-account";
const account = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "tenant-a",
  subjectId: "subject-a",
  status: "active",
  availableMicros: 0n,
  heldMicros: 0n,
};
const headers = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${auth.bffServiceToken}`,
  "x-kokoro-service": "web-bff",
  "x-kokoro-internal-secret": auth.internalServiceSecret,
  "x-kokoro-tenant-id":
    "u1." + Buffer.from(account.tenantId).toString("base64url"),
  "x-kokoro-subject":
    "u1." + Buffer.from(account.subjectId).toString("base64url"),
});
describe("explicit own zero credit account HTTP", () => {
  let app: NestFastifyApplication;
  const open = vi.fn(() => Promise.resolve(account));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        AppModule.register(
          readBillingRuntimeConfig({
            DATABASE_URL:
              "postgresql://unused@localhost/unused?schema=kokoro_billing",
            BILLING_AUTH_MODE: auth.mode,
            BILLING_AUTH_JWKS_URL: auth.jwksUrl,
            BILLING_AUTH_JWT_ISSUER: auth.issuer,
            BILLING_AUTH_JWT_AUDIENCE: auth.audience,
            INTERNAL_SERVICE_SECRET: auth.internalServiceSecret,
            BILLING_BFF_SERVICE_TOKEN: auth.bffServiceToken,
            BILLING_OPERATOR_PROXY_SECRET: auth.operatorProxySecret,
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
      .useValue({ openMyAccount: open })
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
    open.mockReset();
    open.mockResolvedValue(account);
  });
  it("accepts explicit authenticated empty PUT and projects genuine zero values", async () => {
    const response = await app.inject({
      method: "PUT",
      url: path,
      headers: headers(),
      payload: "{}",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { available_micros: "0", held_micros: "0" },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(open).toHaveBeenCalledWith({
      tenantId: account.tenantId,
      subjectId: account.subjectId,
    });
  });
  it("maps only typed disabled errors to dedicated nonretryable403", async () => {
    open.mockRejectedValueOnce(
      new CreditError("CREDIT_ACCOUNT_DISABLED", "private detail"),
    );
    const response = await app.inject({
      method: "PUT",
      url: path,
      headers: headers(),
      payload: "{}",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "billing.credit_account_disabled", retryable: false },
    });
    expect(response.body).not.toContain("private detail");
  });
  for (const field of [
    "authorization",
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "x-kokoro-tenant-id",
    "x-kokoro-subject",
  ] as const)
    it(`rejects missing ${field} before service`, async () => {
      const values: Record<string, string> = headers();
      delete values[field];
      const response = await app.inject({
        method: "PUT",
        url: path,
        headers: values,
        payload: "{}",
      });
      expect(response.statusCode).toBe(403);
      expect(open).not.toHaveBeenCalled();
    });
  for (const payload of [
    "",
    "null",
    "[]",
    '{"subject_id":"other"}',
    '{"amount":0}',
    '{"x":1,"x":2}',
  ])
    it(`rejects nonempty or absent body ${payload}`, async () => {
      const response = await app.inject({
        method: "PUT",
        url: path,
        headers: headers(),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(open).not.toHaveBeenCalled();
    });
  it("rejects query and unsupported MIME without service", async () => {
    for (const request of [
      { url: path + "?x=1", headers: headers() },
      { url: path, headers: { ...headers(), "content-type": "text/plain" } },
    ]) {
      const response = await app.inject({
        method: "PUT",
        ...request,
        payload: "{}",
      });
      expect(response.statusCode).toBe(400);
      expect(open).not.toHaveBeenCalled();
    }
  });
  for (const field of [
    "authorization",
    "x-kokoro-service",
    "x-kokoro-internal-secret",
  ] as const)
    it(`rejects forged ${field}`, async () => {
      const response = await app.inject({
        method: "PUT",
        url: path,
        headers: { ...headers(), [field]: "forged" },
        payload: "{}",
      });
      expect(response.statusCode).toBe(403);
      expect(open).not.toHaveBeenCalled();
    });
  for (const field of [
    "authorization",
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "x-kokoro-tenant-id",
    "x-kokoro-subject",
  ] as const)
    it(`rejects duplicate ${field} before service`, async () => {
      const values = headers();
      const response = await app.inject({
        method: "PUT",
        url: path,
        headers: { ...values, [field]: [values[field], values[field]] },
        payload: "{}",
      });
      expect(response.statusCode).toBe(
        field === "x-kokoro-tenant-id" || field === "x-kokoro-subject"
          ? 400
          : 403,
      );
      expect(open).not.toHaveBeenCalled();
    });
  it("does not authorize direct user/operator tokens through a user fallback", async () => {
    for (const token of [
      "Bearer user-token",
      `Bearer ${auth.operatorProxySecret}`,
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: path,
        headers: {
          authorization: token,
          "x-kokoro-tenant-id": headers()["x-kokoro-tenant-id"],
          "content-type": "application/json",
        },
        payload: "{}",
      });
      expect(response.statusCode).toBe(403);
      expect(open).not.toHaveBeenCalled();
    }
  });
  it("rejects malformed identity and malformed JSON bytes without service", async () => {
    const invalid = await app.inject({
      method: "PUT",
      url: path,
      headers: { ...headers(), "x-kokoro-subject": "subject-a" },
      payload: "{}",
    });
    expect(invalid.statusCode).toBe(400);
    expect(open).not.toHaveBeenCalled();
    for (const payload of [
      Buffer.from([0x7b, 0xff, 0x7d]),
      Buffer.from('{"__proto__":{}}'),
      Buffer.from('{"constructor":{}}'),
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: path,
        headers: headers(),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(open).not.toHaveBeenCalled();
    }
  });
});
