import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";

const config = readBillingRuntimeConfig({
  DATABASE_URL: "postgresql://unused@localhost/unused?schema=kokoro_billing",
  BILLING_AUTH_MODE: "jwks",
  BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
  BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
  BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
  INTERNAL_SERVICE_SECRET: "fixture-internal-secret-000000000001",
  BILLING_BFF_SERVICE_TOKEN: "fixture-bff-service-secret-000000001",
  BILLING_OPERATOR_PROXY_SECRET: "fixture-operator-secret-000000000001",
});

describe("canonical runtime probe authority and retired route removal", () => {
  it("exposes only PostgreSQL readiness, liveness and metrics; does not register retired or unfinished operations", async () => {
    const ping = vi.fn(() => Promise.resolve());
    const module = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    })
      .overrideProvider(PrismaService)
      .useValue({ ping, clientForDatabaseInfrastructure: () => ({}) })
      .compile();
    const adapter = new FastifyAdapter();
    const routes: string[] = [];
    adapter.getInstance().addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method)
        ? route.method
        : [route.method])
        routes.push(`${method} ${route.url}`);
    });
    const app = module.createNestApplication<NestFastifyApplication>(adapter, {
      logger: false,
    });
    await app.init();
    try {
      const expectedPaths = [
        "/healthz",
        "/readyz",
        "/metrics",
        "/v2/commerce/catalog",
        "/v2/billing/me/credit-account",
        "/v2/billing/me/credit-ledger",
      ];
      expect(routes.sort()).toEqual(
        [
          ...expectedPaths.flatMap((path) => [`GET ${path}`, `HEAD ${path}`]),
          "PUT /v2/billing/me/credit-account",
        ].sort(),
      );
      const live = await app.inject({ method: "GET", url: "/healthz" });
      expect(live.statusCode).toBe(200);
      expect(ping).not.toHaveBeenCalled();
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({
        data: {
          module: "kokoro-billing",
          status: "ready",
          dependencies: { postgres: "ok" },
        },
      });
      expect(ready.headers["cache-control"]).toBe("no-store");
      expect(ready.headers["x-request-id"]).toBeTruthy();
      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.headers["content-type"]).toContain("text/plain");
      expect(metrics.body).toContain("billing_http_requests_total");
      ping.mockRejectedValueOnce(new Error("private database diagnostic"));
      const failed = await app.inject({ method: "GET", url: "/readyz" });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({
        error: { code: "billing.dependency_unavailable", retryable: true },
      });
      expect(failed.body).not.toContain("private database diagnostic");
      for (const url of [
        "/v1/billing/me/credit-account",
        "/v1/commerce/catalog",
        "/v1/webhooks/payment/stripe",
        "/v2/billing/me/subscriptions",
        "/credit-account",
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(404);
        expect(response.json()).toMatchObject({
          error: { code: "billing.not_found" },
        });
      }
    } finally {
      await app.close();
    }
  });
});
