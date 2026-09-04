import { describe, expect, it } from 'vitest';
import { createBillingServer, type BillingHttpDependencies } from '../../src/interfaces/http/server.js';

const dependencies = (health: NonNullable<BillingHttpDependencies['health']>): BillingHttpDependencies => ({
  checkout: { create: async () => ({ checkoutId: 'unused', status: 'created', amountMinor: 1, currency: 'USD', expiresAt: new Date('2030-01-01T00:00:00Z') }) },
  usage: { expireExpiredHolds: async (input) => ({ batchId: input.batchId, expiredHoldIds: [] }) },
  settlement: { recordSettlement: async (input) => ({ settlementId: input.settlementId, accepted: true }) },
  reversal: { recordReversal: async () => 'unused' },
  webhook: { accept: async () => ({ providerEventId: 'unused', processingStatus: 'received' }) },
  account: { getForSubject: async () => null },
  auth: {
    user: async () => null,
    bff: async () => null,
    internal: async () => null,
    admin: async () => null,
    webhook: async () => false,
  },
  health,
});

describe('Billing readiness dependency authority', () => {
  it('remains ready with Redis marked degraded when PostgreSQL is healthy', async () => {
    const server = createBillingServer(dependencies({
      postgres: async () => undefined,
      redis: async () => { throw new Error('redis unavailable'); },
    }));
    try {
      const response = await server.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({
        module: 'kokoro-billing',
        status: 'ready',
        dependencies: { postgres: 'ok', redis: 'degraded' },
      });
    } finally {
      await server.close();
    }
  });

  it('is not ready when the PostgreSQL authority is unavailable', async () => {
    const server = createBillingServer(dependencies({
      postgres: async () => { throw new Error('postgres unavailable'); },
      redis: async () => undefined,
    }));
    try {
      const response = await server.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('billing.dependencies_not_ready');
    } finally {
      await server.close();
    }
  });
});
