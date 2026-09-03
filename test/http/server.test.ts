import { describe, expect, it } from 'vitest';
import { createBillingServer } from '../../src/interfaces/http/server.js';
import { WebhookError } from '../../src/application/payment/ports/provider-types.js';

const webhookCalls: unknown[] = [];

const server = createBillingServer({
  catalog: {
    listSellable: async () => ({ items: [{ id: 'offer-1', key: 'pro', name: 'Pro', currency: 'USD', amountMinor: '1999', creditMicros: '1000000', billingInterval: 'month' }] }),
  },
  checkout: {
    create: async () => ({ checkoutId: 'checkout-1', status: 'created', amountMinor: 1999, currency: 'USD', expiresAt: new Date('2030-01-01') }),
  },
  usage: { expireExpiredHolds: async () => ({ expired: 0, expiredHoldIds: [] }) },
  settlement: { recordSettlement: async () => undefined },
  reversal: { recordReversal: async () => 'refund-1' },
  webhook: {
    accept: async (input) => {
      webhookCalls.push(input);
      return { providerEventId: 'event-1', processingStatus: 'received' as const };
    },
  },
  parseWebhook: (_provider, payload) => {
    if ((payload as { invalidPayload?: unknown }).invalidPayload === true) {
      throw new WebhookError('payment.webhook_payload_invalid', 'provider payload is invalid', 400);
    }
    const body = payload as { id?: unknown; tenantId?: unknown; providerAccountRef?: unknown };
    return {
      eventId: String(body.id ?? 'event-1'),
      eventType: 'payment_succeeded',
      payloadTenantId: typeof body.tenantId === 'string' ? body.tenantId : null,
      providerAccountRef: typeof body.providerAccountRef === 'string' ? body.providerAccountRef : null,
      externalPaymentRef: null,
      externalReversalRef: null,
      refundAmountMinor: null,
      orderId: null,
      subscription: null,
    };
  },
  resolveWebhookTenant: async (provider, accountRef) => provider === 'stripe' && accountRef === 'acct-1' ? 'tenant-1' : null,
  account: { getForSubject: async () => ({ accountId: 'account-1', availableMicros: '42', heldMicros: '0' }) },
  accountRead: { ledgerForSubject: async () => ({ entries: [] }) },
  auth: {
    user: async (request) => typeof request.headers['x-kokoro-tenant-id'] === 'string' && typeof request.headers['x-kokoro-subject'] === 'string'
      ? { tenantId: request.headers['x-kokoro-tenant-id'], subjectId: request.headers['x-kokoro-subject'] }
      : null,
    bff: async () => null,
    internal: async () => null,
    admin: async () => null,
    webhook: async () => true,
  },
});

describe('Billing HTTP surface', () => {
  it('exposes liveness, readiness and metrics without authentication', async () => {
    const live = await server.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(live.json().data).toMatchObject({ module: 'kokoro-billing', status: 'ok' });

    const ready = await server.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data.status).toBe('ready');

    const metrics = await server.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
  });

  it('returns the verified user account using only the v1 envelope', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/billing/me/credit-account', headers: { 'x-kokoro-tenant-id': 'tenant-1', 'x-kokoro-subject': 'user-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { account_id: 'account-1' }, meta: { request_id: expect.any(String) } });
    expect(response.json()).not.toHaveProperty('requestId');
  });

  it('reads the ledger subject from verified context instead of requiring a query subject', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/billing/me/credit-ledger?limit=20', headers: { 'x-kokoro-tenant-id': 'tenant-1', 'x-kokoro-subject': 'user-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { entries: [] }, meta: { request_id: expect.any(String) } });
  });

  it('uses the provider account registry as webhook tenant authority', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', payload: { id: 'event-1', providerAccountRef: 'acct-1', tenantId: 'forged-tenant' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('billing.tenant_mismatch');

    const accepted = await server.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', payload: { id: 'event-2', providerAccountRef: 'acct-1', tenantId: 'tenant-1' } });
    expect(accepted.statusCode).toBe(202);
    expect(webhookCalls.at(-1)).toMatchObject({ tenantId: 'tenant-1', provider: 'stripe', providerAccountRef: 'acct-1' });
  });

  it('rejects a non-object provider payload at the HTTP boundary', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', payload: [] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('billing.invalid_request');
  });

  it('does not expose retired pre-v1 route aliases', async () => {
    const retiredRoutes = [
      ['/billing/plans', 'GET'],
      ['/billing/checkout', 'POST'],
      ['/billing/redeem', 'POST'],
      ['/billing/webhooks/mock', 'POST'],
      ['/internal/billing/entitlement/holds', 'POST'],
      ['/admin/billing/reconcile', 'GET'],
    ] as const;

    for (const [url, method] of retiredRoutes) {
      const response = await server.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
