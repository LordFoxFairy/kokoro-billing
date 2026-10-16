import { describe, expect, it } from "vitest";
import { createBillingRuntime } from "../../src/bootstrap/create-billing-runtime.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)(
  "canonical runtime without Redis",
  () => {
    it("initializes and closes repeatedly without Redis or provider configuration", async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const runtime = await createBillingRuntime(
          readBillingRuntimeConfig({
            DATABASE_URL: databaseUrl,
            BILLING_AUTH_MODE: "jwks",
            BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
            BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
            BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
            INTERNAL_SERVICE_SECRET: "fixture-service-secret-000000000001",
            BILLING_BFF_SERVICE_TOKEN: "fixture-bff-token-secret-00000000001",
            BILLING_OPERATOR_PROXY_SECRET:
              "fixture-operator-secret-00000000001",
          }),
        );
        const closing = runtime.close();
        expect(runtime.close()).toBe(closing);
        await closing;
      }
    });
  },
);
