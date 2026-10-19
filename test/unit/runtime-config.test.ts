import { describe, expect, it } from "vitest";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";

const baseEnvironment = (): NodeJS.ProcessEnv => ({
  DATABASE_URL:
    "postgresql://billing:billing@127.0.0.1:5432/billing?schema=kokoro_billing",
  BILLING_AUTH_MODE: "jwks",
  BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
  BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
  BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
  INTERNAL_SERVICE_SECRET: "internal-secret-00000000000000000001",
  BILLING_BFF_SERVICE_TOKEN: "bff-token-000000000000000000000000001",
  BILLING_OPERATOR_PROXY_SECRET: "operator-secret-00000000000000000001",
});

describe("billing production timeout configuration", () => {
  it.each([
    "postgresql://billing@127.0.0.1/billing",
    "postgresql://billing@127.0.0.1/billing?schema=public",
    "postgresql://billing@127.0.0.1/billing?schema=kokoro_billing&schema=kokoro_billing",
    "postgresql://billing@127.0.0.1/billing?schema=kokoro_billing&options=-c%20search_path%3Dpublic",
  ])("rejects an unsafe Billing database URL before runtime startup", (url) => {
    expect(() =>
      readBillingRuntimeConfig({ ...baseEnvironment(), DATABASE_URL: url }),
    ).toThrow(/schema=kokoro_billing|must not contain PostgreSQL options/iu);
  });

  it("provides bounded dependency and shutdown defaults", () => {
    const config = readBillingRuntimeConfig(baseEnvironment());
    expect(config).not.toHaveProperty("redisUrl");
    expect(config).not.toHaveProperty("enabledProviders");
    expect(config.shutdownDeadlineMs).toBe(10_000);
  });

  it("rejects non-positive and internally inconsistent deadlines", () => {
    expect(() =>
      readBillingRuntimeConfig({
        ...baseEnvironment(),
        BILLING_SHUTDOWN_DEADLINE_MS: "not-a-number",
      }),
    ).toThrow("BILLING_SHUTDOWN_DEADLINE_MS must be a positive safe integer");
  });
});
