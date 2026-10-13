import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  createBillingCatalogAuth,
  createBillingPersonalAuth,
} from "../../src/infrastructure/auth/billing-auth.js";
const options = {
  mode: "jwks" as const,
  internalServiceSecret: "set15-auth-internal-fixture-0000001",
  bffServiceToken: "set15-auth-service-bearer-000000001",
  operatorProxySecret: "set15-auth-operator-fixture-0000001",
  issuer: "https://iam.example.test/iam",
  audience: "https://kokoro.dev/resources/billing",
  jwksUrl: "http://127.0.0.1:1/unused",
};
const valid = {
  authorization: `Bearer ${options.bffServiceToken}`,
  "x-kokoro-service": "web-bff",
  "x-kokoro-internal-secret": options.internalServiceSecret,
  "x-kokoro-tenant-id": "u1.dGVuYW50LWE",
};
function request(
  headers: Record<string, string>,
  duplicate?: string,
): FastifyRequest {
  const rawHeaders = Object.entries(headers).flat();
  if (duplicate !== undefined)
    rawHeaders.push(duplicate, headers[duplicate] ?? "");
  return { headers, raw: { rawHeaders } } as unknown as FastifyRequest;
}
describe("Catalog strict optional subject machine authority", () => {
  const auth = createBillingCatalogAuth(options);
  it("retains service actor with and without a validated subject; personal still needs subject", async () => {
    expect(await auth.authenticate(request(valid))).toEqual({
      ok: true,
      context: { tenantId: "tenant-a", actorId: "web-bff" },
    });
    expect(
      await auth.authenticate(
        request({ ...valid, "x-kokoro-subject": "u1.c3ViamVjdC1h" }),
      ),
    ).toEqual({
      ok: true,
      context: { tenantId: "tenant-a", actorId: "web-bff" },
    });
    expect(
      await createBillingPersonalAuth(options).authenticate(request(valid)),
    ).toEqual({ ok: false, status: 403 });
  });
  it.each(["authorization", "x-kokoro-service", "x-kokoro-internal-secret"])(
    "rejects duplicate %s before token fallback",
    async (header) => {
      expect(await auth.authenticate(request(valid, header))).toEqual({
        ok: false,
        status: 403,
      });
    },
  );
  it("rejects duplicate tenant and optional subject identities", async () => {
    expect(
      await auth.authenticate(request(valid, "x-kokoro-tenant-id")),
    ).toEqual({ ok: false, status: 400 });
    expect(
      await auth.authenticate(
        request(
          { ...valid, "x-kokoro-subject": "u1.c3ViamVjdC1h" },
          "x-kokoro-subject",
        ),
      ),
    ).toEqual({ ok: false, status: 400 });
  });
  it.each(["", "subject", "u1.A", "u1.YR", "u1.YQ=", "u1.wA"])(
    "rejects a present invalid optional subject case %#",
    async (subject) => {
      const result = await auth.authenticate(
        request({ ...valid, "x-kokoro-subject": subject }),
      );
      expect(result.ok).toBe(false);
    },
  );
});
