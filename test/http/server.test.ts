import { describe, expect, it } from 'vitest';
import { createBillingServer } from '../../src/interfaces/http/server.js';
import { WebhookError } from '../../src/modules/payment/provider-types.js';

const checkoutCalls: unknown[] = [];
const idempotencyClaims: unknown[] = [];
let idempotencyUnavailable = false;
const reconcileSiteIds: string[] = [];
const webhookCalls: unknown[] = [];
const server = createBillingServer({
  idempotencyHint: { claim: async (...input) => { if (idempotencyUnavailable) throw new Error('redis unavailable'); idempotencyClaims.push(input); return 'claimed'; } },
  catalog: { listSellable: async () => [{ id: 'offer-revision-1', key: 'pro', name: 'Pro', currency: 'USD', amountMinor: '1999', creditMicros: '1000000', billingInterval: 'month' }] },
  checkout: {
    create: async (input) => { checkoutCalls.push(input); return { checkoutId: 'checkout-1', status: 'created', amountMinor: 1999, currency: 'USD', expiresAt: new Date('2030-01-01T00:00:00Z') }; },
  },
  usage: {
    recordUsageEvent: async () => undefined,
    authorizeUsage: async () => ({ holdId: 'hold-1', allocations: [] }),
    settleUsage: async () => ({ settlementId: 'usage-settlement-1', capturedMicros: 1, releasedMicros: 0 }),
    releaseUsage: async () => ({ holdId: 'hold-1', releasedMicros: 1 }),
    ensureUsageEventForHold: async () => 'usage-event-1',
  },
  settlement: { recordSettlement: async () => undefined, fulfillSettlement: async () => ({ fulfillmentId: 'f', grantId: 'g', journalId: 'j' }) },
  reversal: { recordReversal: async () => 'reversal-1', reverseCredits: async () => ({ fulfillmentReversalId: 'fr', journalId: 'j' }) },
  webhook: { accept: async (input) => { webhookCalls.push(input); return { providerEventId: 'event-1', processingStatus: 'received' as const }; } },
  resolveWebhookTenant: async (provider, externalAccountRef) => provider === 'stripe' && externalAccountRef === 'acct-direct-1' ? 'tenant-direct-1' : null,
  resolveWebhookAccountRef: (provider) => provider === 'stripe' ? 'acct-direct-1' : null,
  providerEventAdmin: { list: async () => ({ items: [] }), retry: async (input) => ({ providerEventId: input.providerEventId, processingStatus: 'received' as const }) },
  parseWebhook: (_provider, payload) => {
    if ((payload as { invalidPayload?: unknown }).invalidPayload === true) throw new WebhookError('payment.webhook_payload_invalid', 'provider payload is invalid', 400);
    const body = payload as { id?: unknown; tenantId?: unknown; siteId?: unknown; providerAccountRef?: unknown };
    return { eventId: String(body.id ?? 'event-1'), eventType: 'payment_succeeded', payloadTenantId: typeof body.tenantId === 'string' ? body.tenantId : null, payloadSiteId: typeof body.siteId === 'string' ? body.siteId : null, providerAccountRef: typeof body.providerAccountRef === 'string' ? body.providerAccountRef : null, externalPaymentRef: null, externalReversalRef: null, refundAmountMinor: null, orderId: null, subscription: null };
  },
  account: { getForSubject: async () => ({ accountId: 'account-1', availableMicros: 1 }) },
  accountRead: {
    summaryForSubject: async () => ({ balanceMicros: '1', heldMicros: '0', quotaMicros: null, quotaPeriod: null }),
    ledgerForSubject: async () => ({ entries: [] }),
    byModelForSubject: async () => ({ periodStart: '2026-01-01T00:00:00.000Z', items: [] }),
  },
  ensureAccount: { ensureForSubject: async () => ({ accountId: 'account-1' }) },
  pricing: {
    quote: async () => ({ featureKey: 'chat', labelKey: 'pro', pricingRevisionId: 'price-1', inputTokens: 0, outputTokens: 0, amountMicros: 0, reservationMicros: 10 }),
    quoteForHold: async () => ({ featureKey: 'chat', labelKey: 'pro', pricingRevisionId: 'price-1', inputTokens: 0, outputTokens: 0, amountMicros: 0, reservationMicros: 10 }),
  },
  catalogAdmin: { publishPlan: async (input) => ({ id: 'offer-revision-2', key: input.offerKey, name: input.name, currency: input.currency, amountMinor: String(input.amountMinor), creditMicros: String(input.creditMicros), billingInterval: input.billingInterval }) },
  admin: { reconcile: async (siteId) => { reconcileSiteIds.push(siteId); return { status: 'ok' }; }, grant: async () => ({ grantId: 'grant-1', journalId: 'journal-1' }) },
  adminStats: { get: async () => ({ checkouts: {}, settlements: { byStatus: {}, succeededAmountMinorByCurrency: {} }, reversals: { byStatus: {}, succeededAmountMinorByCurrency: {} }, providerEvents: {}, credit: { accountCount: '0', grantCount: '0', remainingMicros: '0' } }), listCreditOperations: async () => [], listPaymentOperations: async () => [] },
  auth: {
    user: async (request) => ({ tenantId: String(request.headers['x-kokoro-tenant-id']), subjectId: String(request.headers['x-kokoro-subject']) }),
    bff: async () => null,
    internal: async (request) => request.headers['x-kokoro-service'] === 'model' ? { tenantId: String(request.headers['x-kokoro-tenant-id']), serviceId: 'model' } : null,
    admin: async (request) => request.headers['x-kokoro-role'] === 'billing.admin' && typeof request.headers['x-kokoro-operator'] === 'string' ? { tenantId: String(request.headers['x-kokoro-tenant-id']), operatorId: request.headers['x-kokoro-operator'], role: 'billing.admin' } : null,
    webhook: async () => true,
  },
});

describe('Billing API surfaces', () => {
  it('exposes standard liveness and readiness routes', async () => {
    const live = await server.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(live.json().data).toMatchObject({ module: 'kokoro-billing', status: 'ok' });
    const ready = await server.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data.status).toBe('ready');
  });

  it('exposes platform-standard Prometheus metrics without authentication', async () => {
    await server.inject({ method: 'GET', url: '/healthz' });
    const response = await server.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('process_');
    expect(response.body).toContain('billing_http_requests_total');
  });

  it('keeps user checkout behind user context and Idempotency-Key', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/checkout', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-subject': 'user-1', 'idempotency-key': 'checkout-key-1' }, payload: { offerRevisionId: 'offer-1', amountMinor: '1999', currency: 'USD', quoteSnapshot: {} } });
    expect(response.statusCode).toBe(201);
    expect(checkoutCalls[0]).toMatchObject({ siteId: 'site-1', subjectId: 'user-1', idempotencyKey: 'checkout-key-1' });
    expect(idempotencyClaims).toHaveLength(1);
  });

  it('preserves the trusted cross-service request id in the response envelope', async () => {
    const response = await server.inject({ method: 'GET', url: '/billing/plans', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-subject': 'user-1', 'x-kokoro-service': 'web-bff', 'x-kokoro-internal-secret': 'secret', 'x-kokoro-request-id': 'req-billing-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().requestId).toBe('req-billing-1');
  });

  it('rejects an idempotency key outside the public contract bounds', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/checkout', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-subject': 'user-1', 'idempotency-key': 'short' }, payload: { offerRevisionId: 'offer-1', amountMinor: '1999', currency: 'USD', quoteSnapshot: {} } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('billing.idempotency_invalid');
    expect(response.json().requestId).toEqual(expect.any(String));
  });

  it('keeps PostgreSQL-authoritative mutations available when Redis hinting is unavailable', async () => {
    idempotencyUnavailable = true;
    try {
      const response = await server.inject({ method: 'POST', url: '/billing/checkout', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-subject': 'user-1', 'idempotency-key': 'redis-outage-key' }, payload: { offerRevisionId: 'offer-1', amountMinor: '1999', currency: 'USD', quoteSnapshot: {} } });
      expect(response.statusCode).toBe(201);
    } finally {
      idempotencyUnavailable = false;
    }
  });

  it('returns only the site-scoped published catalog through the user surface', async () => {
    const response = await server.inject({ method: 'GET', url: '/billing/plans', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-subject': 'user-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.plans[0]).toMatchObject({ id: 'offer-revision-1', key: 'pro', amountMinor: '1999' });
  });

  it('rejects internal usage mutation without service identity', async () => {
    const response = await server.inject({ method: 'POST', url: '/internal/billing/entitlement/usage/events', headers: { 'idempotency-key': 'usage-key-1' }, payload: { usageEventId: 'usage-1', sourceEventId: 'source-1', subjectId: 'user-1', featureKey: 'model.request', quantityMicros: 1 } });
    expect(response.statusCode).toBe(403);
  });

  it('keeps admin reconciliation behind admin role', async () => {
    const response = await server.inject({ method: 'GET', url: '/admin/billing/reconcile', headers: { 'x-kokoro-role': 'billing.viewer', 'x-kokoro-operator': 'operator-1' } });
    expect(response.statusCode).toBe(403);
  });

  it('does not trust an unsigned tenantId embedded in a provider payload', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/webhooks/mock', payload: { id: 'event-unsigned-tenant', tenantId: 'tenant-forged' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('billing.provider_tenant_missing');
  });

  it('uses provider tenant context as authority and treats payload tenantId as a consistency check', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/webhooks/stripe', headers: { 'x-kokoro-tenant-id': 'tenant-1' }, payload: { id: 'event-tenant-mismatch', tenantId: 'tenant-forged', providerAccountRef: 'acct-direct-1' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('billing.provider_tenant_mismatch');
  });

  it('preserves structured provider parser status and code at the HTTP boundary', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/webhooks/stripe', headers: { 'x-kokoro-tenant-id': 'tenant-1' }, payload: { invalidPayload: true, providerAccountRef: 'acct-direct-1' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('payment.webhook_payload_invalid');
  });

  it('routes a direct-account webhook through configured provider account identity', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/webhooks/stripe', payload: { id: 'event-direct-account' } });
    expect(response.statusCode).toBe(202);
    expect(webhookCalls.at(-1)).toMatchObject({ siteId: 'tenant-direct-1', provider: 'stripe', providerAccountRef: 'acct-direct-1' });
  });

  it('does not use legacy payload siteId as the tenant authority', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/webhooks/stripe', payload: { id: 'event-legacy-site-hint', siteId: 'tenant-direct-1' } });
    expect(response.statusCode).toBe(202);
    expect(webhookCalls.at(-1)).toMatchObject({ siteId: 'tenant-direct-1', provider: 'stripe' });
  });

  it('rejects a legacy payload siteId that disagrees with provider-account authority', async () => {
    const response = await server.inject({ method: 'POST', url: '/billing/webhooks/stripe', payload: { id: 'event-legacy-site-mismatch', siteId: 'tenant-forged' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('billing.provider_tenant_mismatch');
  });

  it('keeps admin stats site-scoped and behind admin role', async () => {
    const response = await server.inject({ method: 'GET', url: '/admin/billing/stats', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.credit.remainingMicros).toBe('0');
  });

  it('exposes site-scoped payment and credit operation read surfaces to admin callers', async () => {
    const payment = await server.inject({ method: 'GET', url: '/admin/billing/payment-operations', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1' } });
    const credit = await server.inject({ method: 'GET', url: '/admin/billing/credit-operations', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1' } });
    expect(payment.statusCode).toBe(200);
    expect(payment.json().data).toEqual([]);
    expect(credit.statusCode).toBe(200);
    expect(credit.json().data).toEqual([]);
  });

  it('passes the authenticated site to reconciliation', async () => {
    const response = await server.inject({ method: 'GET', url: '/admin/billing/reconcile', headers: { 'x-kokoro-tenant-id': 'site-2', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1' } });
    expect(response.statusCode).toBe(200);
    expect(reconcileSiteIds.at(-1)).toBe('site-2');
  });

  it('exposes the bounded-context manifest only to admin callers', async () => {
    const response = await server.inject({ method: 'GET', url: '/admin/billing/manifest', headers: { 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: 'billing', basePath: '/admin/billing' });
    expect(response.json().data.resources.map((resource: { id: string }) => resource.id)).toEqual(expect.arrayContaining(['plans', 'usage-pricing', 'provider-events', 'credit-operations']));
  });

  it('retries provider events through the audited admin command', async () => {
    const response = await server.inject({ method: 'POST', url: '/admin/billing/provider-events/event-1/retry', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1', 'idempotency-key': 'retry-event-1' }, payload: { reason: 'provider timeout' } });
    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({ providerEventId: 'event-1', processingStatus: 'received' });
  });

  it('lists provider events through the site-scoped admin read surface', async () => {
    const response = await server.inject({ method: 'GET', url: '/admin/billing/provider-events?status=failed&limit=10', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([]);
  });

  it('returns the account for the verified user context only', async () => {
    const response = await server.inject({ method: 'GET', url: '/billing/me/credit-account', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-subject': 'user-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.accountId).toBe('account-1');
  });

  it('keeps target account reads behind internal service identity', async () => {
    const response = await server.inject({ method: 'GET', url: '/internal/billing/entitlement/accounts/summary?subjectId=user-1', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-service': 'model' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.balanceMicros).toBe('1');
  });

  it('requires operator context for an admin grant', async () => {
    const response = await server.inject({ method: 'POST', url: '/admin/billing/grants', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-internal-secret': 'secret', 'idempotency-key': 'grant-1' }, payload: { accountId: 'account-1', subjectId: 'user-1', amountMicros: '10', programKey: 'support', reason: 'support' } });
    expect(response.statusCode).toBe(403);
  });

  it('publishes catalog revisions only through the admin surface', async () => {
    const response = await server.inject({ method: 'POST', url: '/admin/billing/plans', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1', 'idempotency-key': 'plan-key-1' }, payload: { offerKey: 'pro', name: 'Pro', currency: 'USD', amountMinor: '1999', creditMicros: '1000000', billingInterval: 'month', reason: 'initial' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.key).toBe('pro');
  });

  it('routes admin refunds through the reversal port with operator context', async () => {
    const response = await server.inject({ method: 'POST', url: '/admin/billing/refunds/settlement-1', headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-role': 'billing.admin', 'x-kokoro-operator': 'operator-1', 'idempotency-key': 'refund-1' }, payload: { accountId: 'account-1', externalReversalRef: 'provider-refund-1', amountMinor: '100', amountMicros: '10', reason: 'customer_request' } });
    expect(response.statusCode).toBe(202);
  });
});
