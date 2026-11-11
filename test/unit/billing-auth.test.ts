import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createBillingPersonalAuth } from "../../src/infrastructure/auth/billing-auth.js";
import { encodeBillingIdentityHeader } from "../../src/infrastructure/auth/billing-identity-header.js";
import type { FastifyRequest } from "fastify";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("billing personal authentication adapter", () => {
  it("verifies EdDSA IAM Billing profiles and binds the tenant header to the token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const jwk = await exportJWK(publicKey);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...jwk, kid: "billing-test-key", alg: "EdDSA" }],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("test server did not bind");
    const token = await new SignJWT({
      sid: "session-1",
      client_id: "web-client",
      scope: "billing:credit.consume",
      "https://kokoro.dev/token_kind": "user_delegated",
      "https://kokoro.dev/tenant_id": "site-1",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "billing-test-key", typ: "JWT" })
      .setSubject("team-1")
      .setIssuer("https://iam.example.test/iam")
      .setAudience("https://kokoro.dev/resources/billing")
      .setIssuedAt()
      .setExpirationTime("5 minutes")
      .sign(privateKey);
    const auth = createBillingPersonalAuth({
      mode: "jwks",
      internalServiceSecret: "jwt-fixture-service-secret-000000001",
      bffServiceToken: "jwt-fixture-bff-bearer-000000000001",
      operatorProxySecret: "jwt-fixture-operator-secret-00000001",
      jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
      issuer: "https://iam.example.test/iam",
      audience: "https://kokoro.dev/resources/billing",
    });

    const request = (tenantId: string): FastifyRequest => {
      const headers = {
        authorization: `Bearer ${token}`,
        "x-kokoro-tenant-id": encodeBillingIdentityHeader(tenantId, "tenant"),
      };
      return {
        headers,
        raw: { rawHeaders: Object.entries(headers).flat() },
      } as unknown as FastifyRequest;
    };
    expect(await auth.authenticate(request("site-1"))).toEqual({
      ok: true,
      context: { tenantId: "site-1", subjectId: "team-1" },
    });
    expect(await auth.authenticate(request("site-2"))).toEqual({
      ok: false,
      status: 403,
    });
  });
});

import Fastify from "fastify";
import { decodeJwt } from "jose";

type R73JwtInput = Readonly<{
  subject: string;
  issuer?: string;
  audience?: string | string[];
  scope?: string;
  kind?: string;
  tenant?: string;
  plainTenantOnly?: boolean;
  expiresAt?: number;
}>;

async function withR73VerifiedUser(
  check: (
    authenticate: (input: R73JwtInput) => Promise<unknown>,
  ) => Promise<void>,
): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = await exportJWK(publicKey);
  const jwksServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        keys: [{ ...jwk, kid: "r73-local-jwks", alg: "EdDSA" }],
      }),
    );
  });
  servers.push(jwksServer);
  await new Promise<void>((resolve) =>
    jwksServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = jwksServer.address();
  if (address === null || typeof address === "string")
    throw new Error("R73 JWKS fixture did not bind");
  const auth = createBillingPersonalAuth({
    mode: "jwks",
    internalServiceSecret: "r73-fixture-service-secret-000000001",
    bffServiceToken: "r73-fixture-bff-token-000000000000001",
    operatorProxySecret: "r73-fixture-operator-secret-00000001",
    issuer: "https://r73-iam.example.test/iam",
    audience: "https://kokoro.dev/resources/billing",
    jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
  });
  const requestFixture = Fastify({ logger: false });
  // This unit probe exercises the active personal factory and real JWKS verifier,
  // without a Controller or a business/database provider.
  requestFixture.get("/__r73_auth_probe", async (request) => {
    const result = await auth.authenticate(request);
    return { context: result.ok ? result.context : null };
  });
  try {
    await check(async (input) => {
      const payload: Record<string, unknown> = {
        sid: "r73-session",
        client_id: "r73-web-client",
        scope: input.scope ?? "billing:credit.consume",
        "https://kokoro.dev/token_kind": input.kind ?? "user_delegated",
        "https://kokoro.dev/tenant_id": input.tenant ?? "tenant-a",
      };
      if (input.plainTenantOnly === true) {
        payload.tenant_id = payload["https://kokoro.dev/tenant_id"];
        delete payload["https://kokoro.dev/tenant_id"];
      }
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: "EdDSA", kid: "r73-local-jwks", typ: "JWT" })
        .setSubject(input.subject)
        .setIssuer(input.issuer ?? "https://r73-iam.example.test/iam")
        .setAudience(input.audience ?? "https://kokoro.dev/resources/billing")
        .setIssuedAt()
        .setExpirationTime(
          input.expiresAt ?? Math.floor(Date.now() / 1000) + 60,
        )
        .sign(privateKey);
      expect(decodeJwt(token).sub).toBe(input.subject);
      const response = await requestFixture.inject({
        method: "GET",
        url: "/__r73_auth_probe",
        headers: {
          authorization: `Bearer ${token}`,
          "x-kokoro-tenant-id": encodeBillingIdentityHeader(
            "tenant-a",
            "tenant",
          ),
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json<unknown>();
    });
  } finally {
    await requestFixture.close();
  }
}

describe("R73 personal factory verified JWT subject boundary", () => {
  it.each([
    ["255 four-byte code points", "😀".repeat(255)],
    ["leading BOM", "\uFEFFsubject-a"],
    ["untrimmed identity", " subject-a "],
    ["decomposed identity", "e\u0301"],
    ["composed identity", "é"],
  ])("preserves a verified legal %s", async (_label, subject) => {
    await withR73VerifiedUser(async (authenticate) => {
      expect(await authenticate({ subject: "subject-a" })).toEqual({
        context: { tenantId: "tenant-a", subjectId: "subject-a" },
      });
      expect(await authenticate({ subject })).toEqual({
        context: { tenantId: "tenant-a", subjectId: subject },
      });
    });
  });

  it.each([
    ["empty subject", ""],
    ["NUL subject", "subject\u0000a"],
    ["256 ASCII code points", "x".repeat(256)],
    ["256 four-byte code points", "😀".repeat(256)],
    ["isolated high surrogate", "subject\uD800"],
    ["isolated low surrogate", "subject\uDC00"],
  ])(
    "rejects a correctly signed %s after a legal control",
    async (_label, subject) => {
      await withR73VerifiedUser(async (authenticate) => {
        expect(await authenticate({ subject: "subject-a" })).toEqual({
          context: { tenantId: "tenant-a", subjectId: "subject-a" },
        });
        expect(await authenticate({ subject })).toEqual({ context: null });
      });
    },
  );

  it.each([
    ["issuer", { issuer: "https://another-iam.example.test/iam" }],
    ["audience", { audience: "another-fixture-owner" }],
    ["expiration", { expiresAt: 1 }],
  ] as const)(
    "rejects a signed JWT with invalid %s after a legal control",
    async (_label, patch) => {
      await withR73VerifiedUser(async (authenticate) => {
        expect(await authenticate({ subject: "subject-a" })).toEqual({
          context: { tenantId: "tenant-a", subjectId: "subject-a" },
        });
        expect(await authenticate({ subject: "subject-a", ...patch })).toEqual({
          context: null,
        });
      });
    },
  );

  it("accepts the exact OpenID dual-audience profile and rejects legacy plain claims", async () => {
    await withR73VerifiedUser(async (authenticate) => {
      const issuer = "https://r73-iam.example.test/iam";
      expect(
        await authenticate({
          subject: "subject-a",
          scope: "billing:credit.consume openid",
          audience: [
            issuer + "/oauth2/userinfo",
            "https://kokoro.dev/resources/billing",
          ],
        }),
      ).toEqual({ context: { tenantId: "tenant-a", subjectId: "subject-a" } });
      expect(
        await authenticate({ subject: "subject-a", plainTenantOnly: true }),
      ).toEqual({ context: null });
      expect(
        await authenticate({ subject: "subject-a", kind: "machine" }),
      ).toEqual({ context: null });
    });
  });
});

import type { FastifyInstance } from "fastify";

// R74: the personal profile is exercised through actual Fastify request headers.
// This probe never calls a personal Controller or a business/database provider.
describe("R74 personal auth selection and u1 boundary", () => {
  const serviceSecret = "r74-fixture-internal-secret-0000000001";
  const serviceToken = "r74-fixture-bff-service-token-00000001";
  async function withPersonalProbe(
    run: (fixture: {
      app: FastifyInstance;
      token: string;
      headers: Record<string, string>;
    }) => Promise<void>,
  ) {
    const { createBillingPersonalAuth } =
      await import("../../src/infrastructure/auth/billing-auth.js");
    const { default: Fastify } = await import("fastify");
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const jwk = await exportJWK(publicKey);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...jwk, kid: "r74-auth", alg: "EdDSA" }],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("JWKS fixture not bound");
    const token = await new SignJWT({
      sid: "r74-session",
      client_id: "r74-web-client",
      scope: "billing:credit.consume",
      "https://kokoro.dev/token_kind": "user_delegated",
      "https://kokoro.dev/tenant_id": "tenant-a",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "r74-auth" })
      .setSubject("subject-a")
      .setIssuer("https://r74-iam.example.test/iam")
      .setAudience("https://kokoro.dev/resources/billing")
      .setIssuedAt()
      .setExpirationTime("5 minutes")
      .sign(privateKey);
    const auth = createBillingPersonalAuth({
      mode: "jwks",
      internalServiceSecret: serviceSecret,
      bffServiceToken: serviceToken,
      operatorProxySecret: "r74-fixture-operator-secret-0000000001",
      jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
      issuer: "https://r74-iam.example.test/iam",
      audience: "https://kokoro.dev/resources/billing",
    });
    const app = Fastify({ logger: false });
    app.get("/__r74_personal_auth_probe", async (request, reply) => {
      const result = await auth.authenticate(request);
      return result.ok
        ? result.context
        : reply.code(result.status).send({ rejected: true });
    });
    try {
      await run({
        app,
        token,
        headers: {
          "x-kokoro-service": "web-bff",
          "x-kokoro-internal-secret": serviceSecret,
          authorization: `Bearer ${serviceToken}`,
          "x-kokoro-tenant-id": "u1.dGVuYW50LWE",
          "x-kokoro-subject": "u1.c3ViamVjdC1h",
        },
      });
    } finally {
      await app.close();
    }
  }
  it("accepts complete machine and independent JWT identities exactly", async () => {
    await withPersonalProbe(async ({ app, token, headers }) => {
      for (const credentials of [
        headers,
        {
          authorization: `Bearer ${token}`,
          "x-kokoro-tenant-id": headers["x-kokoro-tenant-id"],
        },
      ]) {
        const result = await app.inject({
          method: "GET",
          url: "/__r74_personal_auth_probe",
          headers: credentials,
        });
        expect(result.statusCode).toBe(200);
        expect(result.json<unknown>()).toEqual({
          tenantId: "tenant-a",
          subjectId: "subject-a",
        });
      }
    });
  });
  it.each(["x-kokoro-service", "x-kokoro-internal-secret", "x-kokoro-subject"])(
    "selects machine by empty %s presence without JWT fallback",
    async (marker) => {
      await withPersonalProbe(async ({ app, token, headers }) => {
        const control = await app.inject({
          method: "GET",
          url: "/__r74_personal_auth_probe",
          headers,
        });
        expect(control.statusCode).toBe(200);
        const rejected = await app.inject({
          method: "GET",
          url: "/__r74_personal_auth_probe",
          headers: {
            authorization: `Bearer ${token}`,
            "x-kokoro-tenant-id": "u1.dGVuYW50LWE",
            [marker]: "",
          },
        });
        expect(rejected.statusCode).toBe(403);
      });
    },
  );
  it.each([
    "x-kokoro-service",
    "x-kokoro-internal-secret",
    "authorization",
    "x-kokoro-subject",
    "x-kokoro-tenant-id",
  ])("rejects missing machine factor %s", async (factor) => {
    await withPersonalProbe(async ({ app, headers }) => {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/__r74_personal_auth_probe",
            headers,
          })
        ).statusCode,
      ).toBe(200);
      const incomplete = { ...headers };
      delete incomplete[factor];
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/__r74_personal_auth_probe",
            headers: incomplete,
          })
        ).statusCode,
      ).toBe(403);
    });
  });
  it.each([
    { "x-kokoro-service": "model" },
    { "x-kokoro-internal-secret": "forged" },
    { authorization: "Bearer forged" },
  ])("rejects substituted machine credentials case %#", async (patch) => {
    await withPersonalProbe(async ({ app, headers }) => {
      const control = await app.inject({
        method: "GET",
        url: "/__r74_personal_auth_probe",
        headers,
      });
      expect(control.statusCode).toBe(200);
      const rejected = await app.inject({
        method: "GET",
        url: "/__r74_personal_auth_probe",
        headers: { ...headers, ...patch },
      });
      expect(rejected.statusCode).toBe(403);
    });
  });
  it("selects matching dedicated Bearer without any machine header", async () => {
    await withPersonalProbe(async ({ app, headers }) => {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/__r74_personal_auth_probe",
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/__r74_personal_auth_probe",
            headers: {
              authorization: `Bearer ${serviceToken}`,
              "x-kokoro-tenant-id": "u1.dGVuYW50LWE",
            },
          })
        ).statusCode,
      ).toBe(403);
    });
  });
  it.each(["raw-subject", "u1.c3ViamVjdC1h=", "u1.7aCA", "u1._w"])(
    "rejects malformed nonempty subject %s as 400 after legal control",
    async (subject) => {
      await withPersonalProbe(async ({ app, headers }) => {
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/__r74_personal_auth_probe",
              headers,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/__r74_personal_auth_probe",
              headers: { ...headers, "x-kokoro-subject": subject },
            })
          ).statusCode,
        ).toBe(400);
      });
    },
  );
});
