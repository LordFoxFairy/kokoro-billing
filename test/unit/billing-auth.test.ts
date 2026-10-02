import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createBillingAuth } from "../../src/infrastructure/auth/billing-auth.js";

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

describe("billing production authentication adapter", () => {
  it("verifies RS256 IAM sessions from the IAM JWKS and binds the tenant header to the token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...jwk, kid: "billing-test-key", alg: "RS256", use: "sig" }],
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
    const token = await new SignJWT({ tenant_id: "site-1" })
      .setProtectedHeader({ alg: "RS256", kid: "billing-test-key", typ: "JWT" })
      .setSubject("team-1")
      .setIssuer("kokoro-iam")
      .setIssuedAt()
      .setExpirationTime("5 minutes")
      .sign(privateKey);
    const auth = createBillingAuth({
      mode: "jwks",
      internalServiceSecret: "service-secret",
      bffServiceToken: "bff-bearer",
      operatorProxySecret: "operator-secret",
      jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
      issuer: "kokoro-iam",
    });

    const valid = await auth.user({
      headers: {
        authorization: `Bearer ${token}`,
        "x-kokoro-tenant-id": "site-1",
      },
    } as never);
    expect(valid).toEqual({ tenantId: "site-1", subjectId: "team-1" });
    const crossSite = await auth.user({
      headers: {
        authorization: `Bearer ${token}`,
        "x-kokoro-tenant-id": "site-2",
      },
    } as never);
    expect(crossSite).toBeNull();
  });

  it("keeps local internal-header auth separate from production JWT auth", async () => {
    const auth = createBillingAuth({
      mode: "internal-header",
      internalServiceSecret: "service-secret",
      bffServiceToken: "bff-bearer",
      operatorProxySecret: "service-secret",
      issuer: "kokoro-iam",
    });
    expect(
      await auth.user({
        headers: {
          "x-kokoro-tenant-id": "site-1",
          "x-kokoro-subject": "team-1",
        },
      } as never),
    ).toEqual({ tenantId: "site-1", subjectId: "team-1" });
    expect(
      await auth.user({
        headers: {
          authorization: "Bearer fixture-token",
          "x-kokoro-tenant-id": "site-1",
        },
      } as never),
    ).toBeNull();
  });

  it("requires the trusted BFF proxy marker for operator calls", async () => {
    const auth = createBillingAuth({
      mode: "internal-header",
      internalServiceSecret: "service-secret",
      bffServiceToken: "bff-bearer",
      operatorProxySecret: "operator-secret",
      issuer: "kokoro-iam",
    });
    const headers = {
      "x-kokoro-tenant-id": "site-1",
      "x-kokoro-operator": "op-1",
      "x-kokoro-role": "finance",
      "x-kokoro-proxy-secret": "operator-secret",
    };
    expect(await auth.admin({ headers } as never)).toBeNull();
    expect(
      await auth.admin({
        headers: { ...headers, "x-kokoro-service": "admin" },
      } as never),
    ).toBeNull();
    expect(
      await auth.admin({
        headers: {
          ...headers,
          "x-kokoro-service": "admin",
          "x-kokoro-role": "billing.admin",
        },
      } as never),
    ).toMatchObject({
      tenantId: "site-1",
      operatorId: "op-1",
      role: "billing.admin",
    });
  });

  it("accepts only registered internal service identities", async () => {
    const auth = createBillingAuth({
      mode: "internal-header",
      internalServiceSecret: "service-secret",
      bffServiceToken: "bff-bearer",
      operatorProxySecret: "service-secret",
      issuer: "kokoro-iam",
    });
    const headers = {
      "x-kokoro-tenant-id": "site-1",
      "x-kokoro-internal-secret": "service-secret",
    };
    expect(
      await auth.internal({
        headers: { ...headers, "x-kokoro-service": "agent" },
      } as never),
    ).toEqual({ tenantId: "site-1", serviceId: "agent" });
    expect(
      await auth.internal({
        headers: { ...headers, "x-kokoro-service": "unregistered-service" },
      } as never),
    ).toBeNull();
  });

  it("requires the registered web BFF, tenant context, internal secret and service bearer", async () => {
    const auth = createBillingAuth({
      mode: "internal-header",
      internalServiceSecret: "service-secret",
      bffServiceToken: "bff-bearer",
      operatorProxySecret: "operator-secret",
      issuer: "kokoro-iam",
    });
    const headers = {
      "x-kokoro-tenant-id": "site-1",
      "x-kokoro-service": "web-bff",
      "x-kokoro-internal-secret": "service-secret",
      authorization: "Bearer bff-bearer",
      "x-kokoro-subject": "team-1",
    };
    expect(await auth.bff({ headers } as never)).toEqual({
      tenantId: "site-1",
      serviceId: "web-bff",
      subjectId: "team-1",
    });
    expect(
      await auth.bff({
        headers: { ...headers, "x-kokoro-service": "model" },
      } as never),
    ).toBeNull();
    expect(
      await auth.bff({
        headers: { ...headers, "x-kokoro-internal-secret": "forged" },
      } as never),
    ).toBeNull();
    expect(
      await auth.bff({
        headers: { ...headers, authorization: "Bearer forged" },
      } as never),
    ).toBeNull();
    expect(
      await auth.bff({
        headers: { ...headers, "x-kokoro-tenant-id": "" },
      } as never),
    ).toBeNull();
  });

  it("keeps the HTTP tenant boundary aligned with the VARCHAR(191) storage contract", async () => {
    const auth = createBillingAuth({
      mode: "internal-header",
      internalServiceSecret: "service-secret",
      bffServiceToken: "bff-bearer",
      operatorProxySecret: "service-secret",
      issuer: "kokoro-iam",
    });
    const accepted = `tenant-${"x".repeat(184)}`;
    expect(accepted.length).toBe(191);
    expect(
      await auth.user({
        headers: {
          "x-kokoro-tenant-id": accepted,
          "x-kokoro-subject": "team-1",
        },
      } as never),
    ).toMatchObject({ tenantId: accepted });
    expect(
      await auth.user({
        headers: {
          "x-kokoro-tenant-id": `${accepted}x`,
          "x-kokoro-subject": "team-1",
        },
      } as never),
    ).toBeNull();
    expect(
      await auth.user({
        headers: { "x-kokoro-tenant-id": "", "x-kokoro-subject": "team-1" },
      } as never),
    ).toBeNull();
  });
});

import Fastify from "fastify";
import { decodeJwt } from "jose";

type R73JwtInput = Readonly<{
  subject: string;
  issuer?: string;
  audience?: string;
  expiresAt?: number;
}>;

async function withR73VerifiedUser(
  check: (
    authenticate: (input: R73JwtInput) => Promise<unknown>,
  ) => Promise<void>,
): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwksServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        keys: [{ ...jwk, kid: "r73-local-jwks", alg: "RS256", use: "sig" }],
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
  const auth = createBillingAuth({
    mode: "jwks",
    internalServiceSecret: "r73-fixture-service-secret",
    bffServiceToken: "r73-fixture-bff-token",
    operatorProxySecret: "r73-fixture-operator-secret",
    issuer: "r73-fixture-iam",
    audience: "r73-fixture-billing",
    jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
  });
  const requestFixture = Fastify({ logger: false });
  // This unit request route invokes the existing auth.user entry; it is not
  // a production personal-read route, Guard, or authentication selector.
  requestFixture.get("/__r73_auth_probe", async (request) => ({
    context: await auth.user(request),
  }));
  try {
    await check(async (input) => {
      const token = await new SignJWT({ tenant_id: "tenant-a" })
        .setProtectedHeader({ alg: "RS256", kid: "r73-local-jwks", typ: "JWT" })
        .setSubject(input.subject)
        .setIssuer(input.issuer ?? "r73-fixture-iam")
        .setAudience(input.audience ?? "r73-fixture-billing")
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
          "x-kokoro-tenant-id": "tenant-a",
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json<unknown>();
    });
  } finally {
    await requestFixture.close();
  }
}

describe("R73 existing verified JWT subject boundary (not personal HTTP)", () => {
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
    ["issuer", { issuer: "another-fixture-iam" }],
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
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...jwk, kid: "r74-auth", alg: "RS256", use: "sig" }],
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
    const token = await new SignJWT({ tenant_id: "tenant-a" })
      .setProtectedHeader({ alg: "RS256", kid: "r74-auth" })
      .setSubject("subject-a")
      .setIssuer("r74-iam")
      .setAudience("r74-billing")
      .setIssuedAt()
      .setExpirationTime("5 minutes")
      .sign(privateKey);
    const auth = createBillingPersonalAuth({
      mode: "jwks",
      internalServiceSecret: serviceSecret,
      bffServiceToken: serviceToken,
      operatorProxySecret: "r74-fixture-operator-secret-0000000001",
      jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
      issuer: "r74-iam",
      audience: "r74-billing",
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
