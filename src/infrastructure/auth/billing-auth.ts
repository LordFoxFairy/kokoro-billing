import { validateBillingPersonalHttpOptions } from "../../config/runtime-config.js";
import {
  decodeBillingIdentityHeader,
  billingHeaderCount,
} from "./billing-identity-header.js";
import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { createBillingAccessTokenVerifier } from "./billing-access-token.verifier.js";
import type {
  BillingAuthOptions,
  BillingPersonalAuth,
  BillingCatalogAuth,
} from "./billing-auth.types.js";

const headerValue = (
  request: FastifyRequest,
  name: string,
): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const bearer = (request: FastifyRequest): string | undefined => {
  const authorization = headerValue(request, "authorization");
  if (authorization === undefined || !/^Bearer\s+/iu.test(authorization))
    return undefined;
  const token = authorization.replace(/^Bearer\s+/iu, "").trim();
  return token.length > 0 ? token : undefined;
};

const credentialMatches = (
  candidate: string | undefined,
  expected: string,
): boolean => {
  if (candidate === undefined) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
};

export function createBillingPersonalAuth(
  options: BillingAuthOptions,
): BillingPersonalAuth {
  const config = validateBillingPersonalHttpOptions(options);
  const userTokens = createBillingAccessTokenVerifier({
    jwksUrl: config.jwksUrl,
    issuer: config.issuer,
    audience: config.audience,
  });
  const single = (request: FastifyRequest, name: string): boolean =>
    typeof request.headers[name] === "string" &&
    billingHeaderCount(request.raw.rawHeaders, name) === 1;
  const identity = (
    request: FastifyRequest,
    name: string,
    kind: "tenant" | "subject",
  ) => {
    if (!single(request, name))
      throw new TypeError("Repeated Billing identity header");
    return decodeBillingIdentityHeader(request.headers[name], kind);
  };
  return {
    authenticate: async (request) => {
      const token = bearer(request);
      const machine =
        [
          "x-kokoro-service",
          "x-kokoro-internal-secret",
          "x-kokoro-subject",
        ].some((name) => Object.hasOwn(request.headers, name)) ||
        credentialMatches(token, config.bffServiceToken);
      if (machine) {
        if (
          !single(request, "x-kokoro-service") ||
          !single(request, "x-kokoro-internal-secret") ||
          !single(request, "authorization") ||
          request.headers["x-kokoro-service"] !== "web-bff" ||
          !credentialMatches(
            headerValue(request, "x-kokoro-internal-secret"),
            config.internalServiceSecret,
          ) ||
          !credentialMatches(token, config.bffServiceToken)
        )
          return { ok: false, status: 403 };
        for (const name of ["x-kokoro-tenant-id", "x-kokoro-subject"]) {
          if (
            request.headers[name] === undefined ||
            request.headers[name] === ""
          )
            return { ok: false, status: 403 };
        }
        try {
          return {
            ok: true,
            context: Object.freeze({
              tenantId: identity(request, "x-kokoro-tenant-id", "tenant"),
              subjectId: identity(request, "x-kokoro-subject", "subject"),
            }),
          };
        } catch {
          return { ok: false, status: 400 };
        }
      }
      if (token === undefined || !single(request, "authorization"))
        return { ok: false, status: 401 };
      const context = await userTokens.verify(token);
      if (context === null) return { ok: false, status: 401 };
      if (
        request.headers["x-kokoro-tenant-id"] === undefined ||
        request.headers["x-kokoro-tenant-id"] === ""
      )
        return { ok: false, status: 403 };
      try {
        if (
          identity(request, "x-kokoro-tenant-id", "tenant") !== context.tenantId
        )
          return { ok: false, status: 403 };
        return { ok: true, context };
      } catch {
        return { ok: false, status: 400 };
      }
    },
  };
}

/** Catalog machines act as their authenticated service, never as a fabricated user. */
export function createBillingCatalogAuth(
  options: BillingAuthOptions,
): BillingCatalogAuth {
  const config = validateBillingPersonalHttpOptions(options);
  const personal = createBillingPersonalAuth(config);
  return {
    authenticate: async (request) => {
      const token = bearer(request);
      const machine =
        [
          "x-kokoro-service",
          "x-kokoro-internal-secret",
          "x-kokoro-subject",
        ].some((name) => Object.hasOwn(request.headers, name)) ||
        credentialMatches(token, config.bffServiceToken);
      if (!machine || Object.hasOwn(request.headers, "x-kokoro-subject")) {
        const result = await personal.authenticate(request);
        if (!result.ok) return result;
        return {
          ok: true,
          context: Object.freeze({
            tenantId: result.context.tenantId,
            actorId: machine ? "web-bff" : result.context.subjectId,
          }),
        };
      }
      for (const name of [
        "x-kokoro-service",
        "x-kokoro-internal-secret",
        "authorization",
      ]) {
        if (
          typeof request.headers[name] !== "string" ||
          billingHeaderCount(request.raw.rawHeaders, name) !== 1
        )
          return { ok: false, status: 403 };
      }
      if (
        request.headers["x-kokoro-service"] !== "web-bff" ||
        !credentialMatches(
          headerValue(request, "x-kokoro-internal-secret"),
          config.internalServiceSecret,
        ) ||
        !credentialMatches(token, config.bffServiceToken)
      )
        return { ok: false, status: 403 };
      if (
        request.headers["x-kokoro-tenant-id"] === undefined ||
        request.headers["x-kokoro-tenant-id"] === ""
      )
        return { ok: false, status: 403 };
      try {
        if (
          billingHeaderCount(request.raw.rawHeaders, "x-kokoro-tenant-id") !== 1
        )
          return { ok: false, status: 400 };
        return {
          ok: true,
          context: Object.freeze({
            tenantId: decodeBillingIdentityHeader(
              request.headers["x-kokoro-tenant-id"],
              "tenant",
            ),
            actorId: "web-bff",
          }),
        };
      } catch {
        return { ok: false, status: 400 };
      }
    },
  };
}
