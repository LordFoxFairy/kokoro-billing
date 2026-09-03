import { describe, expect, it } from 'vitest';
import { readBillingRuntimeConfig } from '../../src/config/runtime-config.js';

const baseEnvironment = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgresql://billing:billing@127.0.0.1:5432/billing',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  INTERNAL_SERVICE_SECRET: 'internal-secret',
  BILLING_BFF_SERVICE_TOKEN: 'bff-token',
  BILLING_OPERATOR_PROXY_SECRET: 'operator-secret',
});

describe('billing production timeout configuration', () => {
  it('provides bounded dependency and shutdown defaults', () => {
    const config = readBillingRuntimeConfig(baseEnvironment());
    expect(config.redisTimeouts).toEqual({ connectTimeoutMs: 2_000, readTimeoutMs: 1_000, overallTimeoutMs: 3_000 });
    expect(config.stripeTimeouts).toEqual({ connectTimeoutMs: 3_000, readTimeoutMs: 10_000, overallTimeoutMs: 12_000 });
    expect(config.shutdownDeadlineMs).toBe(10_000);
  });

  it('rejects non-positive and internally inconsistent deadlines', () => {
    expect(() => readBillingRuntimeConfig({ ...baseEnvironment(), REDIS_READ_TIMEOUT_MS: '0' })).toThrow('REDIS_READ_TIMEOUT_MS must be a positive safe integer');
    expect(() => readBillingRuntimeConfig({ ...baseEnvironment(), STRIPE_OVERALL_TIMEOUT_MS: '100' })).toThrow('STRIPE_OVERALL_TIMEOUT_MS must be at least');
    expect(() => readBillingRuntimeConfig({ ...baseEnvironment(), BILLING_SHUTDOWN_DEADLINE_MS: 'not-a-number' })).toThrow('BILLING_SHUTDOWN_DEADLINE_MS must be a positive safe integer');
  });
});
