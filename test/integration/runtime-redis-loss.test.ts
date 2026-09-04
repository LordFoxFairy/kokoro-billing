import { describe, expect, it } from 'vitest';
import { createBillingRuntime } from '../../src/bootstrap/create-billing-runtime.js';
import type { BillingRuntimeConfig } from '../../src/config/runtime-config.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

const config = (): BillingRuntimeConfig => {
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    redisUrl: 'redis://127.0.0.1:1/4',
    authMode: 'internal-header',
    internalServiceSecret: 'integration-internal-secret',
    bffServiceToken: 'integration-bff-secret',
    operatorProxySecret: 'integration-operator-secret',
    issuer: 'kokoro-iam',
    enabledProviders: [],
    providerSecrets: {},
    providerAccountRefs: {},
    publicBaseUrl: 'http://127.0.0.1:3000',
    redisTimeouts: { connectTimeoutMs: 50, readTimeoutMs: 50, overallTimeoutMs: 50 },
    stripeTimeouts: { connectTimeoutMs: 50, readTimeoutMs: 50, overallTimeoutMs: 50 },
    shutdownDeadlineMs: 1_000,
    host: '127.0.0.1',
    port: 42_345,
  };
};

integration('runtime recovery without Redis', () => {
  it('starts and restarts against PostgreSQL while reporting the Redis hint degraded', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const runtime = await createBillingRuntime(config());
      try {
        const response = await runtime.server.inject({ method: 'GET', url: '/readyz' });
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({
          status: 'ready',
          dependencies: { postgres: 'ok', redis: 'degraded' },
        });
      } finally {
        await runtime.close();
      }
    }
  });
});
