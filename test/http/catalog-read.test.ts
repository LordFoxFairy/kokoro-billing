import "reflect-metadata";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import {
  BILLING_SCHEMA_VALIDATOR,
  type BillingSchemaValidator,
} from "../../src/infrastructure/auth/billing-auth.types.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";

const config = readBillingRuntimeConfig({
  DATABASE_URL: "postgresql://unused@localhost/unused?schema=kokoro_billing",
  BILLING_AUTH_MODE: "jwks",
  BILLING_AUTH_JWKS_URL: "http://127.0.0.1:1/unused",
  BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
  BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
  INTERNAL_SERVICE_SECRET: "catalog-fixture-internal-secret-0001",
  BILLING_BFF_SERVICE_TOKEN: "catalog-fixture-bff-secret-00000001",
  BILLING_OPERATOR_PROXY_SECRET: "catalog-fixture-operator-secret-001",
});
const headers = {
  "x-kokoro-service": "web-bff",
  "x-kokoro-internal-secret": config.auth.internalServiceSecret,
  authorization: `Bearer ${config.auth.bffServiceToken}`,
  "x-kokoro-tenant-id": "u1.dGVuYW50LWE",
};

describe("canonical Catalog HTTP without user subject fabrication", () => {
  it("serves a genuine empty page through the normal graph for a complete machine without subject", async () => {
    let queryCount = 0;
    const query = vi.fn(() =>
      Promise.resolve(queryCount++ % 3 === 0 ? [{ instant: new Date() }] : []),
    );
    const runRoot = vi.fn((_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    );
    const module = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    })
      .overrideProvider(PrismaService)
      .useValue({
        clientForDatabaseInfrastructure: () => ({}),
        ping: () => Promise.resolve(),
      })
      .overrideProvider(TransactionService)
      .useValue({
        runRoot,
        requireActiveTransaction: () => ({ $queryRaw: query }),
      })
      .compile();
    const app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    try {
      expect(
        (await app.inject({ method: "GET", url: "/healthz" })).statusCode,
      ).toBe(200);
      const response = await app.inject({
        method: "GET",
        url: "/v1/commerce/catalog",
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: { items: [], page: { next_cursor: null } },
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-request-id"]).toBeTruthy();
      const withSubject = await app.inject({
        method: "GET",
        url: "/v1/commerce/catalog",
        headers: { ...headers, "x-kokoro-subject": "u1.c3ViamVjdC1h" },
      });
      expect(withSubject.statusCode).toBe(200);
      const schemas = app.get<BillingSchemaValidator>(BILLING_SCHEMA_VALIDATOR);
      const item = {
        offer_revision_id: "11111111-1111-4111-8111-111111111111",
        offer_key: "plan-a",
        name: "Plan A",
        amount_minor: "9007199254740993",
        currency_code: "USD",
        credit_micros: "0",
        billing_interval: "month",
      };
      schemas.assert("CatalogResponse", {
        data: { items: [item], page: { next_cursor: null } },
      });
      const { offer_key: removed, ...oldItem } = item;
      expect(removed).toBe("plan-a");
      for (const invalid of [
        oldItem,
        { ...item, unknown: true },
        { ...item, amount_minor: 9007199254740992 },
        { ...item, offer_key: "" },
      ])
        expect(() =>
          schemas.assert("CatalogResponse", {
            data: { items: [invalid], page: { next_cursor: null } },
          }),
        ).toThrow();
      const before = query.mock.calls.length;
      for (const missing of [
        "x-kokoro-service",
        "x-kokoro-internal-secret",
        "authorization",
        "x-kokoro-tenant-id",
      ] as const) {
        const partial: Record<string, string> = { ...headers };
        delete partial[missing];
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/v1/commerce/catalog",
              headers: partial,
            })
          ).statusCode,
        ).toBe(403);
      }
      for (const [name, value] of [
        ["x-kokoro-subject", "subject-a"],
        ["x-kokoro-tenant-id", "tenant-a"],
        ["x-kokoro-subject", "u1.A"],
      ] as const) {
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/v1/commerce/catalog",
              headers: { ...headers, [name]: value },
            })
          ).statusCode,
        ).toBe(400);
      }
      for (const patch of [
        { authorization: "Bearer wrong" },
        { "x-kokoro-service": "agent" },
        { "x-kokoro-internal-secret": "wrong" },
      ]) {
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/v1/commerce/catalog",
              headers: { ...headers, ...patch },
            })
          ).statusCode,
        ).toBe(403);
      }
      for (const suffix of [
        "?limit=0",
        "?limit=101",
        "?limit=1&limit=2",
        "?offset=1",
        "?cursor=A",
      ])
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/v1/commerce/catalog" + suffix,
              headers,
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/commerce/catalog",
            headers: { ...headers, "content-length": "0" },
          })
        ).statusCode,
      ).toBe(400);
      expect(query.mock.calls.length).toBe(before);
      expect(
        (await app.inject({ method: "GET", url: "/v1/commerce/catalog" }))
          .statusCode,
      ).toBe(401);
      // Catalog's optional subject never relaxes personal five-factor routes.
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/billing/me/credit-account",
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(runRoot).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-a",
          actorId: "web-bff",
          mode: "readOnlySnapshot",
        }),
        expect.any(Function),
      );
    } finally {
      await app.close();
    }
  });
});
