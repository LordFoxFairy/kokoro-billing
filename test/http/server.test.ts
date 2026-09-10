import { z } from 'zod';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingServer, type BillingHttpDependencies } from '../../src/interfaces/http/server.js';
import { WebhookError } from '../../src/application/payment/ports/provider-types.js';
import { parseProviderWebhook, verifyProviderWebhook } from '../../src/application/payment/ports/provider-registry.js';
import { createProviderRegistry } from '../../src/infrastructure/providers/payment/provider-registry.js';
import { signAlipayNotification } from '../../src/infrastructure/providers/payment/adapters/alipay/alipay-webhook-provider.js';

const anyString: unknown = expect.any(String);

const dataEnvelope = z.object({ data: z.record(z.string(), z.unknown()) });
const errorEnvelope = z.object({ error: z.record(z.string(), z.unknown()) });

const webhookCalls: unknown[] = [];

const dependencies: BillingHttpDependencies = {
  catalog: {
    listSellable: async () => Promise.resolve(({ items: [{ id: 'offer-1', key: 'pro', name: 'Pro', currency: 'USD', amountMinor: '1999', creditMicros: '1000000', billingInterval: 'month' }] })),
  },
  checkout: {
    create: async () => Promise.resolve(({ checkoutId: 'checkout-1', status: 'created', amountMinor: 1999, currency: 'USD', expiresAt: new Date('2030-01-01') })),
  },
  usage: { expireExpiredHolds: async (input) => Promise.resolve(({ batchId: input.batchId, expiredHoldIds: [] })) },
  settlement: { recordSettlement: async (input) => Promise.resolve(({ settlementId: input.settlementId, accepted: true })) },
  reversal: { recordReversal: async () => Promise.resolve('refund-1') },
  webhook: {
    accept: async (input) => {
      webhookCalls.push(input);
      return Promise.resolve({ providerEventId: 'event-1', processingStatus: 'received' as const });
    },
  },
  parseWebhook: (_provider, payload) => {
    if ((payload as { invalidPayload?: unknown }).invalidPayload === true) {
      throw new WebhookError('payment.webhook_payload_invalid', 'provider payload is invalid', 400);
    }
    const body = payload as { id?: unknown; tenantId?: unknown; providerAccountRef?: unknown };
    return {
      eventId: typeof body.id === 'string' ? body.id : 'event-1',
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
  resolveWebhookTenant: async (provider, accountRef) => Promise.resolve(provider === 'stripe' && accountRef === 'acct-1' ? 'tenant-1' : null),
  account: { getForSubject: async () => Promise.resolve(({ accountId: 'account-1', availableMicros: '42', heldMicros: '0' })) },
  accountRead: { ledgerForSubject: async () => Promise.resolve(({ entries: [] })) },
  auth: {
    user: async (request) => Promise.resolve(typeof request.headers['x-kokoro-tenant-id'] === 'string' && typeof request.headers['x-kokoro-subject'] === 'string'
      ? { tenantId: request.headers['x-kokoro-tenant-id'], subjectId: request.headers['x-kokoro-subject'] }
      : null),
    bff: async () => Promise.resolve(null),
    internal: async () => Promise.resolve(null),
    admin: async () => Promise.resolve(null),
    webhook: async () => Promise.resolve(true),
  },
};
const server = createBillingServer(dependencies);

describe('Billing HTTP surface', () => {
  it('exposes liveness, readiness and metrics without authentication', async () => {
    const live = await server.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(dataEnvelope.parse(live.json<unknown>()).data).toMatchObject({ module: 'kokoro-billing', status: 'ok' });

    const ready = await server.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(dataEnvelope.parse(ready.json<unknown>()).data.status).toBe('ready');

    const metrics = await server.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
  });

  it('returns the verified user account using only the v1 envelope', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/billing/me/credit-account', headers: { 'x-kokoro-tenant-id': 'tenant-1', 'x-kokoro-subject': 'user-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { account_id: 'account-1' }, meta: { request_id: anyString } });
    expect(response.json()).not.toHaveProperty('requestId');
  });

  it('reads the ledger subject from verified context instead of requiring a query subject', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/billing/me/credit-ledger?limit=20', headers: { 'x-kokoro-tenant-id': 'tenant-1', 'x-kokoro-subject': 'user-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { entries: [] }, meta: { request_id: anyString } });
  });

  it('uses the provider account registry as webhook tenant authority', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', payload: { id: 'event-1', providerAccountRef: 'acct-1', tenantId: 'forged-tenant' } });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelope.parse(response.json<unknown>()).error.code).toBe('billing.tenant_mismatch');

    const accepted = await server.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', payload: { id: 'event-2', providerAccountRef: 'acct-1', tenantId: 'tenant-1' } });
    expect(accepted.statusCode).toBe(202);
    expect(webhookCalls.at(-1)).toMatchObject({ tenantId: 'tenant-1', provider: 'stripe', providerAccountRef: 'acct-1' });
  });

  it('rejects a non-object provider payload at the HTTP boundary', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', payload: [] });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelope.parse(response.json<unknown>()).error.code).toBe('billing.invalid_request');
  });

  it('rejects providers outside the production registry before webhook processing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/payment/mock',
      payload: { id: 'event-mock' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelope.parse(response.json<unknown>()).error.code).toBe('billing.provider_not_supported');
  });

  it('accepts Alipay RSA2 only from the signed form body and ignores a query signature', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const publicKeyPem = publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const registry = createProviderRegistry(['alipay']);
    const params = { notify_id: 'notify-http-1', sign_type: 'RSA2', app_id: 'app-1', trade_status: 'TRADE_SUCCESS', trade_no: 'trade-http-1' };
    const signed = { ...params, sign: signAlipayNotification(params, privateKeyPem) };
    const acceptedEvents: unknown[] = [];
    const alipayServer = createBillingServer({
      checkout: { create: async () => Promise.resolve(({ checkoutId: 'checkout-1', status: 'created', amountMinor: 1, currency: 'USD', expiresAt: new Date('2030-01-01') })) },
      usage: { expireExpiredHolds: async (input) => Promise.resolve(({ batchId: input.batchId, expiredHoldIds: [] })) },
      settlement: { recordSettlement: async (input) => Promise.resolve(({ settlementId: input.settlementId, accepted: true })) },
      reversal: { recordReversal: async () => Promise.resolve('refund-1') },
      webhook: { accept: async (input) => {
        acceptedEvents.push(input);
        return Promise.resolve({ providerEventId: 'event-alipay-1', processingStatus: 'received' as const });
      } },
      parseWebhook: (provider, payload) => parseProviderWebhook(registry, provider, payload),
      resolveWebhookTenant: async (provider, accountRef) => Promise.resolve(provider === 'alipay' && accountRef === 'app-1' ? 'tenant-1' : null),
      account: { getForSubject: async () => Promise.resolve(null) },
      auth: {
        user: async () => Promise.resolve(null),
        bff: async () => Promise.resolve(null),
        internal: async () => Promise.resolve(null),
        admin: async () => Promise.resolve(null),
        webhook: async (request) => Promise.resolve(verifyProviderWebhook(registry, 'alipay', request.headers, Buffer.from(request.rawBody ?? ''), publicKeyPem)),
      },
    });

    try {
      const accepted = await alipayServer.inject({
        method: 'POST',
        url: '/v1/webhooks/payment/alipay',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(signed).toString(),
      });
      expect(accepted.statusCode).toBe(202);
      expect(acceptedEvents).toHaveLength(1);

      const queryOnly = await alipayServer.inject({
        method: 'POST',
        url: `/v1/webhooks/payment/alipay?sign=${encodeURIComponent(signed.sign)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(params).toString(),
      });
      expect(queryOnly.statusCode).toBe(401);
      expect(acceptedEvents).toHaveLength(1);
    } finally {
      await alipayServer.close();
    }
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

describe('webhook fallback input types', () => {
  it.each(['id', 'type'] as const)('rejects non-string %s before calling inbox', async (field) => {
    const fallbackDependencies = { ...dependencies };
    delete fallbackDependencies.parseWebhook;
    delete fallbackDependencies.resolveWebhookTenant;
    const accepted: unknown[] = [];
    const app = createBillingServer({ ...fallbackDependencies, webhook: { accept: (input) => {
      accepted.push(input);
      return Promise.resolve({ providerEventId: 'fallback-event', processingStatus: 'received' });
    } } });
    try {
      for (const value of [{}, [], ['event'], true, 123]) {
        const response = await app.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', headers: { 'x-kokoro-tenant-id': 'tenant-1' }, payload: { id: 'event', type: 'payment_succeeded', [field]: value } });
        expect(response.statusCode, JSON.stringify(value)).toBe(400);
        expect(response.json<unknown>()).toMatchObject({ error: { code: 'billing.provider_payload_invalid' } });
      }
      expect(accepted).toEqual([]);
    } finally { await app.close(); }
  });

  it('preserves string, null and absent fallbacks and parsed-value precedence', async () => {
    const fallbackDependencies = { ...dependencies };
    delete fallbackDependencies.parseWebhook;
    delete fallbackDependencies.resolveWebhookTenant;
    const accepted: unknown[] = [];
    const webhook: BillingHttpDependencies['webhook'] = { accept: (input) => {
      accepted.push(input);
      return Promise.resolve({ providerEventId: 'fallback-event', processingStatus: 'received' });
    } };
    const app = createBillingServer({ ...fallbackDependencies, webhook });
    const parsedApp = createBillingServer({ ...dependencies, webhook });
    try {
      for (const payload of [{ id: 'raw-id', type: 'raw-type' }, { id: null, type: null }, {}]) {
        const response = await app.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', headers: { 'x-kokoro-tenant-id': 'tenant-1' }, payload });
        expect(response.statusCode).toBe(202);
      }
      expect(accepted).toMatchObject([
        { externalEventId: 'raw-id', eventType: 'raw-type' },
        { externalEventId: '', eventType: 'unknown' },
        { externalEventId: '', eventType: 'unknown' },
      ]);
      const parsed = await parsedApp.inject({ method: 'POST', url: '/v1/webhooks/payment/stripe', payload: { id: {}, type: [], providerAccountRef: 'acct-1' } });
      expect(parsed.statusCode).toBe(202);
      expect(accepted.at(-1)).toMatchObject({ externalEventId: 'event-1', eventType: 'payment_succeeded' });
    } finally { await app.close(); await parsedApp.close(); }
  });
});
