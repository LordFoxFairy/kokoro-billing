import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { BillingAuth, BillingAdminContext, BillingBffContext, BillingInternalContext, BillingUserContext } from '../../interfaces/http/server.js';

type AuthMode = 'header-fixture' | 'jwks';

export type BillingAuthOptions = {
  readonly mode: AuthMode;
  readonly internalServiceSecret: string;
  /** The bearer credential emitted by the BFF when it calls Billing. */
  readonly bffServiceToken?: string;
  readonly operatorProxySecret: string;
  readonly jwksUrl?: string;
  readonly issuer: string;
  readonly audience?: string;
};

const headerValue = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const boundedIdentityValue = (value: string | undefined, maxLength = 255): string | undefined => {
  if (value === undefined || value.length === 0 || value.length > maxLength) return undefined;
  if ([...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; })) return undefined;
  return value;
};

const tenantValue = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0 || value.length > 191) return undefined;
  if ([...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; })) return undefined;
  return value;
};

const sameTenant = (request: FastifyRequest, tenantId: string): boolean => {
  const requestedTenant = tenantValue(headerValue(request, 'x-kokoro-tenant-id'));
  return requestedTenant === tenantId;
};

const bearer = (request: FastifyRequest): string | undefined => {
  const authorization = headerValue(request, 'authorization');
  if (authorization === undefined || !/^Bearer\s+/iu.test(authorization)) return undefined;
  const token = authorization.replace(/^Bearer\s+/iu, '').trim();
  return token.length > 0 ? token : undefined;
};

const credentialMatches = (candidate: string | undefined, expected: string): boolean => {
  if (candidate === undefined) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
};

const registeredInternalServices = new Set(['agent', 'model', 'studio', 'session', 'web-bff', 'payment-worker', 'scheduler']);

const fixtureUser = (request: FastifyRequest): BillingUserContext | null => {
  const tenantId = tenantValue(headerValue(request, 'x-kokoro-tenant-id'));
  const subjectId = boundedIdentityValue(headerValue(request, 'x-kokoro-subject'));
  return tenantId !== undefined && subjectId !== undefined ? { tenantId, subjectId } : null;
};

const trustedInternal = (request: FastifyRequest, secret: string): BillingInternalContext | null => {
  const tenantId = tenantValue(headerValue(request, 'x-kokoro-tenant-id'));
  const serviceId = headerValue(request, 'x-kokoro-service');
  return credentialMatches(headerValue(request, 'x-kokoro-internal-secret'), secret) && tenantId !== undefined && serviceId !== undefined && registeredInternalServices.has(serviceId)
    ? { tenantId, serviceId }
    : null;
};

const trustedBff = (request: FastifyRequest, internalSecret: string, serviceToken: string): BillingBffContext | null => {
  const tenantId = tenantValue(headerValue(request, 'x-kokoro-tenant-id'));
  const subjectHeader = headerValue(request, 'x-kokoro-subject');
  const subjectId = boundedIdentityValue(subjectHeader);
  return headerValue(request, 'x-kokoro-service') === 'web-bff'
    && credentialMatches(headerValue(request, 'x-kokoro-internal-secret'), internalSecret)
    && credentialMatches(bearer(request), serviceToken)
    && tenantId !== undefined
    && (subjectHeader === undefined || subjectId !== undefined)
    ? { tenantId, serviceId: 'web-bff', ...(subjectId === undefined ? {} : { subjectId }) }
    : null;
};

const trustedAdmin = (request: FastifyRequest, secret: string): BillingAdminContext | null => {
  const service = headerValue(request, 'x-kokoro-service');
  const tenantId = tenantValue(headerValue(request, 'x-kokoro-tenant-id'));
  const operatorId = headerValue(request, 'x-kokoro-operator');
  const role = headerValue(request, 'x-kokoro-role');
  return service === 'admin' && credentialMatches(headerValue(request, 'x-kokoro-proxy-secret'), secret)
    && tenantId !== undefined && operatorId !== undefined && role === 'billing.admin'
    ? { tenantId, operatorId, role }
    : null;
};

export const createBillingAuth = (options: BillingAuthOptions): BillingAuth => {
  const bffServiceToken = options.bffServiceToken ?? options.internalServiceSecret;
  if (options.mode === 'jwks' && options.operatorProxySecret === options.internalServiceSecret) {
    throw new Error('billing auth misconfiguration: production admin proxy secret must be distinct from service secret');
  }
  if (options.mode === 'header-fixture') {
    return {
      user: async (request) => fixtureUser(request),
      internal: async (request) => trustedInternal(request, options.internalServiceSecret),
      bff: async (request) => trustedBff(request, options.internalServiceSecret, bffServiceToken),
      admin: async (request) => trustedAdmin(request, options.operatorProxySecret),
      webhook: async () => true,
    };
  }

  if (options.jwksUrl === undefined) throw new Error('billing auth misconfiguration: BILLING_AUTH_JWKS_URL is required');
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl), { cacheMaxAge: 300_000, cooldownDuration: 10_000 });
  return {
    user: async (request) => {
      const token = bearer(request);
      if (token === undefined) return null;
      try {
        const verification = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer: options.issuer,
          ...(options.audience === undefined ? {} : { audience: options.audience }),
        });
        const tenantId = typeof verification.payload.tenant_id === 'string' ? tenantValue(verification.payload.tenant_id) : undefined;
        const subjectId = typeof verification.payload.sub === 'string' ? verification.payload.sub : undefined;
        return tenantId !== undefined && subjectId !== undefined && sameTenant(request, tenantId) ? { tenantId, subjectId } : null;
      } catch {
        return null;
      }
    },
    internal: async (request) => trustedInternal(request, options.internalServiceSecret),
    bff: async (request) => trustedBff(request, options.internalServiceSecret, bffServiceToken),
    admin: async (request) => trustedAdmin(request, options.operatorProxySecret),
    webhook: async () => true,
  };
};
