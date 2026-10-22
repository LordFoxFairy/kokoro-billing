import "reflect-metadata";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
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
import { TransactionService } from "../../src/database/transaction.service.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";
import { MeteringPricingPublicationService } from "../../src/modules/metering/metering-pricing-publication.service.js";
import { MeteringPricingRevisionRepository } from "../../src/modules/metering/metering-pricing-revision.repository.js";
import { MeteringError } from "../../src/modules/metering/metering.error.js";

const secret = {
  internal: "pricing-internal-secret-000000000001",
  bearer: "pricing-bff-bearer-token-00000000001",
  operator: "pricing-operator-secret-000000000001",
};
const base = "/v1/admin/billing/metering";
const common = {
  effective_from: "2026-10-01T00:00:00.000Z",
  source_ref: "QA synthetic price, not procurement",
  verified_at: "2026-10-01T00:00:00.000Z",
};
const rate = {
  ...common,
  rates: [
    {
      provider_ref: "provider",
      environment: "test",
      pricing_account_ref: "account",
      model_ref: "model",
      model_version: "1",
      bucket: "input_total",
      unit: "token",
      applicability: { kind: "all" },
      currency_code: "USD",
      minor_per_unit: { numerator: "1", denominator: "1000" },
    },
  ],
};
const policy = {
  ...common,
  currency_code: "USD",
  multiplier: { numerator: "7", denominator: "5" },
  credit_micros_per_minor: { numerator: "1000000", denominator: "1" },
  max_attempt_credits: "10",
};
const publication = {
  schemaVersion: 1,
  tenantId: "tenant-pricing",
  kind: "rate",
  revision: "1",
  contentDigest: "a".repeat(64),
  publishedAt: common.verified_at,
  effectiveFrom: common.effective_from,
};
const command = (configuration: unknown) => ({
  publication_id: "11111111-1111-4111-8111-111111111111",
  reason: "QA pricing acceptance",
  configuration,
});
const headers = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${secret.bearer}`,
  "x-kokoro-service": "web-bff",
  "x-kokoro-internal-secret": secret.internal,
  "x-kokoro-proxy-secret": secret.operator,
  "x-kokoro-tenant-id":
    "u1." + Buffer.from("tenant-pricing").toString("base64url"),
  "x-kokoro-subject":
    "u1." + Buffer.from("operator-pricing").toString("base64url"),
  "idempotency-key": "pricing-key-1",
});
describe("formal administrative metering management HTTP (owner I/O explicitly stubbed)", () => {
  let app: NestFastifyApplication;
  const publishRate = vi.fn(),
    publishPolicy = vi.fn(),
    readLatest = vi.fn();
  const runRoot = vi.fn((_scope: unknown, callback: () => Promise<unknown>) =>
    callback(),
  );
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
            INTERNAL_SERVICE_SECRET: secret.internal,
            BILLING_BFF_SERVICE_TOKEN: secret.bearer,
            BILLING_OPERATOR_PROXY_SECRET: secret.operator,
          }),
        ),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({
        ping: () => Promise.resolve(),
        clientForDatabaseInfrastructure: () => ({}),
      })
      .overrideProvider(TransactionService)
      .useValue({ runRoot })
      .overrideProvider(MeteringPricingPublicationService)
      .useValue({ publishRate, publishPolicy })
      .overrideProvider(MeteringPricingRevisionRepository)
      .useValue({ readLatest })
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
    vi.clearAllMocks();
    publishRate.mockResolvedValue(publication);
    publishPolicy.mockResolvedValue({ ...publication, kind: "policy" });
    readLatest.mockResolvedValue({ rate: null, policy: null });
  });
  it.each([
    ["rate", rate, "1"],
    ["policy", policy, "2"],
  ] as const)(
    "publishes %s using only authenticated identity and owner-fixed protocol",
    async (kind, configuration, schemaVersion) => {
      const response = await app.inject({
        method: "POST",
        url: `${base}/${kind}-revisions`,
        headers: headers(),
        payload: command(configuration),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        data: {
          kind,
          revision: "1",
          content_digest: publication.contentDigest,
          published_at: common.verified_at,
          effective_from: common.effective_from,
        },
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-request-id"]).toBeTruthy();
      const publisher = kind === "rate" ? publishRate : publishPolicy;
      expect(publisher).toHaveBeenCalledWith(
        {
          tenantId: "tenant-pricing",
          operatorId: "operator-pricing",
          role: "billing.admin",
        },
        expect.objectContaining({
          tenantId: "tenant-pricing",
          actorId: "operator-pricing",
          publicationIdentity: command(configuration).publication_id,
          idempotencyKey: "pricing-key-1",
          draft: expect.objectContaining({
            schemaVersion,
            profileRef: {
              version: "2.0.0",
              artifactDigest:
                "7c5fd0b24d0a691cfcf769a981d8b4a8a689534d9b4ae1b5968342bde591094c",
            },
          }) as unknown,
        }),
      );
    },
  );
  it("returns an honest empty tenant snapshot in one read-only transaction, never a zero price", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${base}/pricing`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { rate_revision: null, policy_revision: null },
    });
    expect(runRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-pricing",
        actorId: "operator-pricing",
        mode: "readOnlySnapshot",
      }),
      expect.any(Function),
    );
    expect(readLatest).toHaveBeenCalledWith("tenant-pricing");
    expect(publishRate).not.toHaveBeenCalled();
    expect(publishPolicy).not.toHaveBeenCalled();
  });
  it.each([
    "authorization",
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "x-kokoro-proxy-secret",
    "x-kokoro-tenant-id",
    "x-kokoro-subject",
  ])("rejects a partial management capability missing %s", async (name) => {
    const input: Record<string, string> = headers();
    delete input[name];
    for (const [method, path] of [
      ["GET", "pricing"],
      ["POST", "rate-revisions"],
      ["POST", "policy-revisions"],
    ] as const) {
      const response = await app.inject({
        method,
        url: `${base}/${path}`,
        headers: input,
        ...(method === "POST"
          ? { payload: command(path.startsWith("rate") ? rate : policy) }
          : {}),
      });
      expect(response.statusCode).toBe(403);
    }
    expect(publishRate).not.toHaveBeenCalled();
    expect(publishPolicy).not.toHaveBeenCalled();
    expect(readLatest).not.toHaveBeenCalled();
  });
  it.each([
    { ...policy, max_attempt_credits: "9223372036855" },
    { ...policy, max_attempt_credits: "0" },
    { ...policy, multiplier: { numerator: "14", denominator: "10" } },
    { ...policy, effective_from: "2026-02-30T00:00:00.000Z" },
    { ...policy, profile_ref: { version: "1" } },
  ])(
    "rejects bad policy semantics before receipt/transaction %#",
    async (configuration) => {
      const response = await app.inject({
        method: "POST",
        url: `${base}/policy-revisions`,
        headers: headers(),
        payload: command(configuration),
      });
      expect(response.statusCode).toBe(400);
      expect(publishPolicy).not.toHaveBeenCalled();
      expect(runRoot).not.toHaveBeenCalled();
    },
  );
  it("rejects nested decoded duplicate keys rather than silently changing budget intent", async () => {
    const raw = JSON.stringify(command(policy)).replace(
      '"max_attempt_credits":"10"',
      '"max_attempt_credits":"10","max_attempt_\\u0063redits":"20"',
    );
    const response = await app.inject({
      method: "POST",
      url: `${base}/policy-revisions`,
      headers: headers(),
      payload: raw,
    });
    expect(response.statusCode).toBe(400);
    expect(publishPolicy).not.toHaveBeenCalled();
  });
  it("does not turn conflicts or corruption into a successful publication", async () => {
    publishPolicy.mockRejectedValueOnce(
      new MeteringError(
        "METERING_PUBLICATION_CONFLICT",
        "Private supplier detail",
      ),
    );
    const conflict = await app.inject({
      method: "POST",
      url: `${base}/policy-revisions`,
      headers: headers(),
      payload: command(policy),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain("Private supplier");
    readLatest.mockRejectedValueOnce(
      new MeteringError("METERING_POLICY_CORRUPT", "Secret SQL"),
    );
    const corrupt = await app.inject({
      method: "GET",
      url: `${base}/pricing`,
      headers: headers(),
    });
    expect(corrupt.statusCode).toBe(500);
    expect(corrupt.body).not.toContain("Secret SQL");
  });
  it.each([
    ["pricing?limit=1", "GET"],
    ["rate-revisions?tenant_id=other", "POST"],
    ["policy-revisions?unexpected=", "POST"],
  ] as const)(
    "rejects queries instead of adding an alternate scope: %s",
    async (path, method) => {
      const response = await app.inject({
        method,
        url: `${base}/${path}`,
        headers: headers(),
        ...(method === "POST"
          ? { payload: command(path.startsWith("rate") ? rate : policy) }
          : {}),
      });
      expect(response.statusCode).toBe(400);
      expect(readLatest).not.toHaveBeenCalled();
      expect(publishRate).not.toHaveBeenCalled();
      expect(publishPolicy).not.toHaveBeenCalled();
    },
  );
  it.each([
    { publication_id: "bad" },
    { tenant_id: "other" },
    { actor_id: "other" },
    { role: "billing.admin" },
    { reason: "  " },
  ])(
    "rejects identity injection and malformed command fields %#",
    async (extra) => {
      const response = await app.inject({
        method: "POST",
        url: `${base}/policy-revisions`,
        headers: headers(),
        payload: { ...command(policy), ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(publishPolicy).not.toHaveBeenCalled();
    },
  );
  it.each(["short", " ", "é".repeat(8)])(
    "rejects a noncanonical key %s",
    async (key) => {
      const response = await app.inject({
        method: "POST",
        url: `${base}/policy-revisions`,
        headers: { ...headers(), "idempotency-key": key },
        payload: command(policy),
      });
      expect(response.statusCode).toBe(400);
      expect(publishPolicy).not.toHaveBeenCalled();
    },
  );
  it.each([
    "authorization",
    "x-kokoro-internal-secret",
    "x-kokoro-proxy-secret",
  ])("requires each independent correct credential: %s", async (name) => {
    const response = await app.inject({
      method: "GET",
      url: `${base}/pricing`,
      headers: { ...headers(), [name]: "wrong" },
    });
    expect(response.statusCode).toBe(403);
    expect(readLatest).not.toHaveBeenCalled();
  });
  it("preserves dependency uncertainty without leaking details or manufacturing a publication", async () => {
    publishPolicy.mockRejectedValueOnce(
      new MeteringError("METERING_PUBLICATION_UNAVAILABLE", "Private SQL"),
    );
    const response = await app.inject({
      method: "POST",
      url: `${base}/policy-revisions`,
      headers: headers(),
      payload: command(policy),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("Private SQL");
  });
});
