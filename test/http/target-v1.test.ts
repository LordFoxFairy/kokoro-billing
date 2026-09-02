import { describe, expect, it } from 'vitest';
import { createBillingServer } from '../../src/interfaces/http/server.js';

const admissionResult = { admissionId: 'adm-1', holdId: 'hold-1', mode: 'credit' as const, pricePolicyRevisionId: 'price-1', amountMicros: '42', currency: 'CRD' as const, status: 'held' as const };
const calls: { capture: unknown[]; release: unknown[]; events: unknown[] } = { capture: [], release: [], events: [] };
const checkoutCalls: unknown[] = [];

const server = createBillingServer({
  catalog: { listSellable: async () => [{ id: 'offer-revision-1', key: 'pro', name: 'Pro', currency: 'USD', amountMinor: '1999', creditMicros: '1000000', billingInterval: 'month' }] },
  checkout: { create: async (input) => { checkoutCalls.push(input); return { checkoutId: 'checkout-1', status: 'created', amountMinor: 1999, currency: 'USD', expiresAt: new Date('2030-01-01') }; } },
  usage: { recordUsageEvent: async () => undefined, authorizeUsage: async () => ({ holdId: 'hold-1', allocations: [] }), settleUsage: async () => ({ settlementId: 's-1', capturedMicros: 1, releasedMicros: 0 }), releaseUsage: async () => ({ holdId: 'hold-1', releasedMicros: 1 }), ensureUsageEventForHold: async () => 'usage-1' },
  settlement: { recordSettlement: async () => undefined, fulfillSettlement: async () => ({ fulfillmentId: 'f-1', grantId: 'g-1', journalId: 'j-1' }) },
  reversal: { recordReversal: async () => 'refund-1', reverseCredits: async () => ({ fulfillmentReversalId: 'r-1', journalId: 'j-1' }) },
  webhook: { accept: async () => ({ providerEventId: 'evt-1', processingStatus: 'received' as const }) },
  account: { getForSubject: async () => ({ accountId: 'account-1', availableMicros: '42', heldMicros: '0' }) },
  admin: { reconcile: async () => ({ status: 'ok' }), grant: async () => ({ grantId: 'grant-1', journalId: 'journal-1' }) },
  admission: {
    create: async () => admissionResult,
    capture: async (...input) => { calls.capture.push(input); return { ...admissionResult, status: 'accepted_without_charge' as const }; },
    release: async (...input) => { calls.release.push(input); return { ...admissionResult, status: 'rejected' as const }; },
    recordExecutionEvent: async (...input) => { calls.events.push(input); return { eventId: 'event-1', status: 'received' as const }; },
  },
  auth: {
    user: async (request) => ({ tenantId: String(request.headers['x-kokoro-tenant-id']), subjectId: 'subject-1' }),
    internal: async (request) => ({ tenantId: String(request.headers['x-kokoro-tenant-id']), serviceId: String(request.headers['x-kokoro-service']) }),
    admin: async () => null,
    webhook: async () => true,
  },
});

const internalHeaders = { 'x-kokoro-tenant-id': 'tenant-1', 'x-kokoro-service': 'agent', 'idempotency-key': 'key-123456' };

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
