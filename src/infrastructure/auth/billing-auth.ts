import { validateBillingPersonalHttpOptions } from "../../config/runtime-config.js";
import {
  decodeBillingIdentityHeader,
  billingHeaderCount,
} from "./billing-identity-header.js";
import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { createBillingAccessTokenVerifier } from "./billing-access-token.verifier.js";
import type {
  BillingAuth,
  BillingAdminContext,
  BillingBffContext,
  BillingInternalContext,
  BillingUserContext,
  BillingAuthOptions,
  BillingPersonalAuth,
} from "./billing-auth.types.js";

const headerValue = (
  request: FastifyRequest,
  name: string,
): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const boundedIdentityValue = (
  value: string | undefined,
  maxLength = 255,
): string | undefined => {
  if (value === undefined || value.length === 0 || value.length > maxLength)
    return undefined;
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  )
    return undefined;
  return value;
};

const tenantValue = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0 || value.length > 191)
    return undefined;
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  )
    return undefined;
  return value;
};

const sameTenant = (request: FastifyRequest, tenantId: string): boolean => {
  const requestedTenant = tenantValue(
    headerValue(request, "x-kokoro-tenant-id"),
  );
  return requestedTenant === tenantId;
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

const registeredInternalServices = new Set([
  "agent",
  "model",
  "studio",
  "session",
  "web-bff",
  "payment-worker",
  "scheduler",
]);

const internalHeaderUser = (
  request: FastifyRequest,
): BillingUserContext | null => {
  const tenantId = tenantValue(headerValue(request, "x-kokoro-tenant-id"));
  const subjectId = boundedIdentityValue(
    headerValue(request, "x-kokoro-subject"),
  );
  return tenantId !== undefined && subjectId !== undefined
    ? { tenantId, subjectId }
    : null;
};

const trustedInternal = (
  request: FastifyRequest,
  secret: string,
): BillingInternalContext | null => {
  const tenantId = tenantValue(headerValue(request, "x-kokoro-tenant-id"));
  const serviceId = headerValue(request, "x-kokoro-service");
  return credentialMatches(
    headerValue(request, "x-kokoro-internal-secret"),
    secret,
  ) &&
    tenantId !== undefined &&
    serviceId !== undefined &&
    registeredInternalServices.has(serviceId)
    ? { tenantId, serviceId }
    : null;
};

const trustedBff = (
  request: FastifyRequest,
  internalSecret: string,
  serviceToken: string,
): BillingBffContext | null => {
  const tenantId = tenantValue(headerValue(request, "x-kokoro-tenant-id"));
  const subjectHeader = headerValue(request, "x-kokoro-subject");
  const subjectId = boundedIdentityValue(subjectHeader);
  return headerValue(request, "x-kokoro-service") === "web-bff" &&
    credentialMatches(
      headerValue(request, "x-kokoro-internal-secret"),
      internalSecret,
    ) &&
    credentialMatches(bearer(request), serviceToken) &&
    tenantId !== undefined &&
    (subjectHeader === undefined || subjectId !== undefined)
    ? {
        tenantId,
        serviceId: "web-bff",
        ...(subjectId === undefined ? {} : { subjectId }),
      }
    : null;
};

const trustedAdmin = (
  request: FastifyRequest,
  secret: string,
): BillingAdminContext | null => {
  const service = headerValue(request, "x-kokoro-service");
  const tenantId = tenantValue(headerValue(request, "x-kokoro-tenant-id"));
  const operatorId = headerValue(request, "x-kokoro-operator");
  const role = headerValue(request, "x-kokoro-role");
  return service === "admin" &&
    credentialMatches(headerValue(request, "x-kokoro-proxy-secret"), secret) &&
    tenantId !== undefined &&
    operatorId !== undefined &&
    role === "billing.admin"
    ? { tenantId, operatorId, role }
    : null;
};

export const createBillingAuth = (options: BillingAuthOptions): BillingAuth => {
  const bffServiceToken = options.bffServiceToken;
  if (
    options.mode === "jwks" &&
    options.operatorProxySecret === options.internalServiceSecret
  ) {
    throw new Error(
      "billing auth misconfiguration: production admin proxy secret must be distinct from service secret",
    );
  }
  if (options.mode === "internal-header") {
    return {
      user: async (request) => Promise.resolve(internalHeaderUser(request)),
      internal: async (request) =>
        Promise.resolve(
          trustedInternal(request, options.internalServiceSecret),
        ),
      bff: async (request) =>
        Promise.resolve(
          trustedBff(request, options.internalServiceSecret, bffServiceToken),
        ),
      admin: async (request) =>
        Promise.resolve(trustedAdmin(request, options.operatorProxySecret)),
      webhook: async () => Promise.resolve(true),
    };
  }

  if (options.jwksUrl === undefined)
    throw new Error(
      "billing auth misconfiguration: BILLING_AUTH_JWKS_URL is required",
    );
  if (options.audience === undefined)
    throw new Error(
      "billing auth misconfiguration: BILLING_AUTH_JWT_AUDIENCE is required",
    );
  const userTokens = createBillingAccessTokenVerifier({
    jwksUrl: options.jwksUrl,
    issuer: options.issuer,
    audience: options.audience,
  });
  return {
    user: async (request) => {
      const token = bearer(request);
      if (token === undefined) return null;
      const context = await userTokens.verify(token);
      return context !== null && sameTenant(request, context.tenantId)
        ? context
        : null;
    },
    internal: async (request) =>
      Promise.resolve(trustedInternal(request, options.internalServiceSecret)),
    bff: async (request) =>
      Promise.resolve(
        trustedBff(request, options.internalServiceSecret, bffServiceToken),
      ),
    admin: async (request) =>
      Promise.resolve(trustedAdmin(request, options.operatorProxySecret)),
    webhook: async () => Promise.resolve(true),
  };
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
