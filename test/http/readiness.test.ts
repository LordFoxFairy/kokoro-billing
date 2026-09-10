import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createBillingServer,
  type BillingHttpDependencies,
} from "../../src/interfaces/http/server.js";

const dataEnvelope = z.object({ data: z.record(z.string(), z.unknown()) });
const errorEnvelope = z.object({ error: z.record(z.string(), z.unknown()) });

const dependencies = (
  health: NonNullable<BillingHttpDependencies["health"]>,
): BillingHttpDependencies => ({
  checkout: {
    create: async () =>
      Promise.resolve({
        checkoutId: "unused",
        status: "created",
        amountMinor: 1,
        currency: "USD",
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      }),
  },
  usage: {
    expireExpiredHolds: async (input) =>
      Promise.resolve({ batchId: input.batchId, expiredHoldIds: [] }),
  },
  settlement: {
    recordSettlement: async (input) =>
      Promise.resolve({ settlementId: input.settlementId, accepted: true }),
  },
  reversal: { recordReversal: async () => Promise.resolve("unused") },
  webhook: {
    accept: async () =>
      Promise.resolve({
        providerEventId: "unused",
        processingStatus: "received",
      }),
  },
  account: { getForSubject: async () => Promise.resolve(null) },
  auth: {
    user: async () => Promise.resolve(null),
    bff: async () => Promise.resolve(null),
    internal: async () => Promise.resolve(null),
    admin: async () => Promise.resolve(null),
    webhook: async () => Promise.resolve(false),
  },
  health,
});

describe("Billing readiness dependency authority", () => {
  it("remains ready with Redis marked degraded when PostgreSQL is healthy", async () => {
    const server = createBillingServer(
      dependencies({
        postgres: async () => Promise.resolve(undefined),
        redis: async () => {
          return Promise.reject(new Error("redis unavailable"));
        },
      }),
    );
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      expect(dataEnvelope.parse(response.json<unknown>()).data).toEqual({
        module: "kokoro-billing",
        status: "ready",
        dependencies: { postgres: "ok", redis: "degraded" },
      });
    } finally {
      await server.close();
    }
  });

  it("is not ready when the PostgreSQL authority is unavailable", async () => {
    const server = createBillingServer(
      dependencies({
        postgres: async () => {
          return Promise.reject(new Error("postgres unavailable"));
        },
        redis: async () => Promise.resolve(undefined),
      }),
    );
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      expect(errorEnvelope.parse(response.json<unknown>()).error.code).toBe(
        "billing.dependencies_not_ready",
      );
    } finally {
      await server.close();
    }
  });
});
