import { describe, expect, it } from 'vitest';
import { createBillingServer } from '../../src/interfaces/http/server.js';

const admissionResult = { admissionId: 'adm-1', holdId: 'hold-1', mode: 'credit' as const, pricePolicyRevisionId: 'price-1', amountMicros: '42', currency: 'CRD' as const, status: 'held' as const };
const calls: { capture: unknown[]; release: unknown[]; events: unknown[] } = { capture: [], release: [], events: [] };
const checkoutCalls: unknown[] = [];
const idempotencyFingerprints = new Map<string, string>();

const server = createBillingServer({
  idempotencyHint: { claim: async (key, fingerprint) => {
    const previous = idempotencyFingerprints.get(key);
    if (previous !== undefined) return previous === fingerprint ? 'replay' : 'conflict';
    idempotencyFingerprints.set(key, fingerprint);
    return 'claimed';
  } },
  catalog: { listSellable: async () => [{ id: 'offer-revision-1', key: 'pro', name: 'Pro', currency: 'USD', amountMinor: '1999', creditMicros: '1000000', billingInterval: 'month' }] },
  checkout: { create: async (input) => { checkoutCalls.push(input); return { checkoutId: 'checkout-1', status: 'created', amountMinor: 1999, currency: 'USD', expiresAt: new Date('2030-01-01') }; } },
  usage: { expireExpiredHolds: async () => ({ expired: 0, expiredHoldIds: [] }) },
  settlement: { recordSettlement: async () => undefined },
  reversal: { recordReversal: async () => 'refund-1' },
  webhook: { accept: async () => ({ providerEventId: 'evt-1', processingStatus: 'received' as const }) },
  account: { getForSubject: async () => ({ accountId: 'account-1', availableMicros: '42', heldMicros: '0' }) },
  admission: {
    create: async () => admissionResult,
    capture: async (...input) => { calls.capture.push(input); return { ...admissionResult, status: 'accepted_without_charge' as const }; },
    release: async (...input) => { calls.release.push(input); return { ...admissionResult, status: 'rejected' as const }; },
    recordExecutionEvent: async (...input) => { calls.events.push(input); return { eventId: 'event-1', status: 'received' as const }; },
  },
  auth: {
    user: async (request) => request.headers['x-kokoro-service'] === undefined ? { tenantId: String(request.headers['x-kokoro-tenant-id']), subjectId: 'subject-1' } : null,
    bff: async (request) => request.headers['x-kokoro-service'] === 'web-bff'
      && request.headers['x-kokoro-internal-secret'] === 'secret'
      && request.headers.authorization === 'Bearer secret'
      && typeof request.headers['x-kokoro-tenant-id'] === 'string'
      && (request.headers['x-kokoro-subject'] === undefined || typeof request.headers['x-kokoro-subject'] === 'string')
      ? { tenantId: request.headers['x-kokoro-tenant-id'], serviceId: 'web-bff', ...(typeof request.headers['x-kokoro-subject'] === 'string' ? { subjectId: request.headers['x-kokoro-subject'] } : {}) }
      : null,
    internal: async (request) => ({ tenantId: String(request.headers['x-kokoro-tenant-id']), serviceId: String(request.headers['x-kokoro-service']) }),
    admin: async () => null,
    webhook: async () => true,
  },
});

const internalHeaders = { 'x-kokoro-tenant-id': 'tenant-1', 'x-kokoro-service': 'agent', 'idempotency-key': 'key-123456' };
const bffHeaders = { 'x-kokoro-tenant-id': 'tenant-1', 'x-kokoro-service': 'web-bff', 'x-kokoro-internal-secret': 'secret', authorization: 'Bearer secret', 'x-kokoro-subject': 'subject-1' };

describe('clean-build Billing v1 transport', () => {
  it('uses only the data/meta envelope and snake_case for the user catalog surface', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/commerce/catalog', headers: { 'x-kokoro-tenant-id': 'tenant-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { offers: [{ id: 'offer-revision-1', key: 'pro', name: 'Pro', currency: 'USD', amount_minor: '1999', credit_micros: '1000000', billing_interval: 'month' }] },
      meta: { request_id: expect.any(String) },
    });
    expect(response.json()).not.toHaveProperty('requestId');
  });

  it('uses meta.request_id and snake_case for the user ledger surface', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/billing/me/credit-account', headers: { 'x-kokoro-tenant-id': 'tenant-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.request_id).toEqual(expect.any(String));
    expect(response.json().data.account_id).toBe('account-1');
    expect(response.json().data.available_micros).toBe('42');
    expect(response.json()).not.toHaveProperty('requestId');
  });

  it('adapts snake_case quote_snapshot fields to the existing checkout service DTO', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { 'x-kokoro-tenant-id': 'tenant-1', 'idempotency-key': 'checkout-v1-123456' }, payload: {
      offer_revision_id: 'offer-revision-1', amount_minor: '1999', currency: 'USD', quote_snapshot: { key: 'pro', credit_micros: '1000000', name: 'Pro', pricing_revision_id: 'price-1' },
    } });
    expect(response.statusCode).toBe(201);
    expect(checkoutCalls.at(-1)).toEqual(expect.objectContaining({
      offerRevisionId: 'offer-revision-1', amountMinor: 1999, currency: 'USD', quoteSnapshot: { key: 'pro', creditMicros: '1000000', name: 'Pro', pricingRevisionId: 'price-1' },
    }));
    expect(response.json().data).toEqual({ checkout_id: 'checkout-1', status: 'created', amount_minor: '1999', currency: 'USD', expires_at: '2030-01-01T00:00:00.000Z' });
    expect(response.json()).not.toHaveProperty('requestId');
  });

  it('allows the authenticated web BFF to read the catalog and create checkout', async () => {
    const catalog = await server.inject({ method: 'GET', url: '/v1/commerce/catalog', headers: bffHeaders });
    const checkout = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { ...bffHeaders, 'idempotency-key': 'bff-checkout-123456' }, payload: {
      offer_revision_id: 'offer-revision-1', amount_minor: '1999', currency: 'USD', quote_snapshot: { key: 'pro', credit_micros: '1000000' },
    } });
    expect(catalog.statusCode).toBe(200);
    expect(checkout.statusCode).toBe(201);
    expect(checkoutCalls.at(-1)).toMatchObject({ tenantId: 'tenant-1', subjectId: 'subject-1', idempotencyKey: 'bff-checkout-123456' });
  });

  it('requires the BFF subject context for checkout while keeping user-only reads JWT-only', async () => {
    const checkout = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { ...Object.fromEntries(Object.entries(bffHeaders).filter(([key]) => key !== 'x-kokoro-subject')), 'idempotency-key': 'bff-missing-subject-123456' }, payload: {
      offer_revision_id: 'offer-revision-1', amount_minor: '1999', currency: 'USD', quote_snapshot: { key: 'pro', credit_micros: '1000000' },
    } });
    const account = await server.inject({ method: 'GET', url: '/v1/billing/me/credit-account', headers: bffHeaders });
    expect(checkout.statusCode).toBe(403);
    expect(checkout.json().error.code).toBe('billing.service_subject_required');
    expect(account.statusCode).toBe(401);
  });

  it('rejects forged or incomplete BFF credentials without downgrading to user auth', async () => {
    const without = (name: string): Record<string, string> => Object.fromEntries(Object.entries(bffHeaders).filter(([key]) => key !== name));
    const cases = [
      { name: 'forged service', headers: { ...bffHeaders, 'x-kokoro-service': 'model' } },
      { name: 'missing internal secret', headers: without('x-kokoro-internal-secret') },
      { name: 'missing service bearer', headers: without('authorization') },
      { name: 'missing tenant context', headers: without('x-kokoro-tenant-id') },
    ];
    for (const testCase of cases) {
      const response = await server.inject({ method: 'GET', url: '/v1/commerce/catalog', headers: testCase.headers });
      expect(response.statusCode, testCase.name).toBe(403);
      expect(response.json().error.code, testCase.name).toBe('billing.service_auth_failed');
    }
  });

  it('replays a duplicate BFF checkout with the same key and rejects a changed payload', async () => {
    const payload = { offer_revision_id: 'offer-revision-1', amount_minor: '1999', currency: 'USD', quote_snapshot: { key: 'pro', credit_micros: '1000000' } };
    const first = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { ...bffHeaders, 'idempotency-key': 'bff-replay-123456' }, payload });
    const duplicate = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { ...bffHeaders, 'idempotency-key': 'bff-replay-123456' }, payload });
    const conflict = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { ...bffHeaders, 'idempotency-key': 'bff-replay-123456' }, payload: { ...payload, amount_minor: '2999' } });
    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().data.checkout_id).toBe(first.json().data.checkout_id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('billing.idempotency_conflict');
  });

  it('uses the v1 envelope for errors without a top-level requestId', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { 'x-kokoro-tenant-id': 'tenant-1' }, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'billing.idempotency_required', request_id: expect.any(String), retryable: false, details: {} }, meta: { request_id: expect.any(String) } });
    expect(response.json()).not.toHaveProperty('requestId');
  });

  it('rejects caller-selected account and amount fields at admission boundary', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/internal/entitlement/admissions', headers: internalHeaders, payload: {
      billing_subject: { kind: 'project', ref: 'subject-1' }, payer_ref: 'payer-1', feature_key: 'chat', surface: 'ga', invocation_id: 'inv-1', execution_id: 'exec-1', meter_kind: 'model_invocation', account_id: 'forged', amount: '1',
    } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('billing.invalid_request');
  });

  it('maps admission, capture, release and event commands without exposing internal DTO names', async () => {
    const create = await server.inject({ method: 'POST', url: '/v1/internal/entitlement/admissions', headers: internalHeaders, payload: { billing_subject: { kind: 'project', ref: 'subject-1' }, payer_ref: 'payer-1', feature_key: 'chat', surface: 'ga', invocation_id: 'inv-1', execution_id: 'exec-1', meter_kind: 'model_invocation' } });
    expect(create.statusCode).toBe(201);
    expect(create.json().data).toEqual({ admission_id: 'adm-1', hold_id: 'hold-1', mode: 'credit', price_policy_revision_id: 'price-1', amount: '42', currency: 'CRD', status: 'held' });
    expect(create.json().meta.request_id).toEqual(expect.any(String));

    const capture = await server.inject({ method: 'POST', url: '/v1/internal/entitlement/admissions/adm-1/capture', headers: internalHeaders, payload: { invocation_id: 'inv-1', execution_id: 'exec-1', accepted_provider_ref: 'provider-op-1', accepted_at: '2026-09-01T00:00:00Z', service_receipt: { result_digest: 'digest' }, receipt_schema_version: '1' } });
    expect(capture.statusCode).toBe(200);
    expect(calls.capture[0]).toEqual(['tenant-1', 'adm-1', expect.objectContaining({ invocationId: 'inv-1' }), 'key-123456']);

    const release = await server.inject({ method: 'POST', url: '/v1/internal/entitlement/admissions/adm-1/release', headers: { ...internalHeaders, 'idempotency-key': 'release-123456' }, payload: { invocation_id: 'inv-1', reason: 'execution.failed' } });
    expect(release.statusCode).toBe(200);
    expect(calls.release[0]).toEqual(['tenant-1', 'adm-1', 'execution.failed', 'release-123456']);

    const event = await server.inject({ method: 'POST', url: '/v1/internal/billing/execution-events', headers: { ...internalHeaders, 'idempotency-key': 'event-123456' }, payload: { event_id: 'event-1', event_type: 'execution.unknown', execution_id: 'exec-1', invocation_id: 'inv-1', occurred_at: '2026-09-01T00:00:00Z', receipt_schema_version: '1', signature: 'signature' } });
    expect(event.statusCode).toBe(202);
    expect(calls.events[0]).toEqual([expect.objectContaining({ tenantId: 'tenant-1', eventId: 'event-1', eventType: 'execution.unknown' })]);
  });

  it('limits the scheduler surface to its generic expiry command', async () => {
    const forbidden = await server.inject({ method: 'POST', url: '/v1/internal/commands/expire-credit-holds', headers: { ...internalHeaders, 'x-kokoro-service': 'agent', 'idempotency-key': 'sweep-123456' }, payload: {} });
    expect(forbidden.statusCode).toBe(403);
  });
});
