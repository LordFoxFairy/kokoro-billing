import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CheckoutService } from '../../modules/payment/checkout-service.js';
import type { BillingSettlementService } from '../../modules/payment/billing-settlement-service.js';
import type { ProviderEventInboxService } from '../../modules/payment/provider-event-inbox-service.js';
import type { UsageSettlementService } from '../../modules/metering/usage-settlement-service.js';
import type { CreditAccountQueryService } from '../../modules/credit/account-query-service.js';
import type { BillingReversalService } from '../../modules/payment/billing-reversal-service.js';
import type { ParsedWebhookEvent } from '../../modules/payment/provider-types.js';
import type { CatalogService } from '../../modules/catalog/catalog-service.js';
import type { RedisIdempotencyHint } from '../../infrastructure/redis/idempotency-hint.js';
import type { BillingAdmissionService, BillingAdmissionResult } from '../../modules/metering/billing-admission-service.js';
import { WebhookError } from '../../modules/payment/provider-types.js';
import { readSafeInteger } from '../../infrastructure/postgres/safe-integer.js';
import { recordHttpRequest, registerMetricsRoute } from '../../infrastructure/metrics.js';
import { runWithBillingContext } from '../../infrastructure/postgres/connection.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    billingStartedAt?: bigint;
  }
}

// HTTP uses the platform tenant vocabulary. Existing application ports still
// expose the repository's internal tenantId value object; this is the only
// translation point and is not part of the wire contract.
export type BillingUserContext = { readonly tenantId: string; readonly subjectId: string };
export type BillingInternalContext = { readonly tenantId: string; readonly serviceId: string };
export type BillingBffContext = { readonly tenantId: string; readonly serviceId: 'web-bff'; readonly subjectId?: string };
export type BillingAdminContext = { readonly tenantId: string; readonly operatorId: string; readonly role: string };
export type BillingAuth = {
  readonly user: (request: FastifyRequest) => Promise<BillingUserContext | null>;
  readonly internal: (request: FastifyRequest) => Promise<BillingInternalContext | null>;
  readonly bff: (request: FastifyRequest) => Promise<BillingBffContext | null>;
  readonly admin: (request: FastifyRequest) => Promise<BillingAdminContext | null>;
  readonly webhook: (request: FastifyRequest) => Promise<boolean>;
};

type CheckoutPort = Pick<CheckoutService, 'create'> & Partial<Pick<CheckoutService, 'createHostedSession'>>;
type UsagePort = Pick<UsageSettlementService, 'expireExpiredHolds'>;
type WebhookPort = Pick<ProviderEventInboxService, 'accept'>;
type AccountPort = Pick<CreditAccountQueryService, 'getForSubject'>;
type ReversalPort = Pick<BillingReversalService, 'recordReversal'>;
type AdmissionPort = Pick<BillingAdmissionService, 'create' | 'capture' | 'release' | 'recordExecutionEvent'>;
type WebhookParser = (provider: string, payload: unknown) => ParsedWebhookEvent;

export type BillingHttpDependencies = {
  readonly idempotencyHint?: Pick<RedisIdempotencyHint, 'claim'>;
  readonly catalog?: Pick<CatalogService, 'listSellable'>;
  readonly checkout: CheckoutPort;
  readonly usage: UsagePort;
  readonly settlement: Pick<BillingSettlementService, 'recordSettlement'>;
  readonly reversal: ReversalPort;
  readonly webhook: WebhookPort;
  readonly parseWebhook?: WebhookParser;
  readonly resolveWebhookTenant?: (provider: string, externalAccountRef: string) => Promise<string | null>;
  /** For direct provider webhooks whose signed event omits a top-level account ref. */
  readonly resolveWebhookAccountRef?: (provider: string) => string | null;
  readonly account: AccountPort;
  readonly accountRead?: Pick<CreditAccountQueryService, 'ledgerForSubject'>;
  readonly subscriptionRead?: { readonly listForSubject: (tenantId: string, subjectId: string) => Promise<readonly Record<string, unknown>[]> };
  readonly admission?: AdmissionPort;
  readonly auth: BillingAuth;
  readonly health?: { readonly postgres: () => Promise<void>; readonly redis: () => Promise<void> };
};

const decimalString = z.string().regex(/^(0|[1-9]\d*)$/u).refine((value) => Number.isSafeInteger(Number(value)), 'decimal value exceeds JavaScript safe integer range');
const positiveDecimalString = decimalString.refine((value) => BigInt(value) > 0n, 'value must be positive');
const safeDecimal = (value: string, field: string): number => readSafeInteger(value, field);
const ledgerPageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).optional() }).strict();
const billingSubjectSchema = z.object({ kind: z.enum(['user', 'project', 'organization', 'service']), ref: z.string().min(1).max(255) }).strict();
const admissionSchema = z.object({
  billing_subject: billingSubjectSchema,
  payer_ref: z.string().min(1).max(255), feature_key: z.string().min(1).max(128), surface: z.string().min(1).max(32),
  invocation_id: z.string().min(1).max(255), execution_id: z.string().min(1).max(255),
  meter_kind: z.enum(['model_invocation', 'feature', 'studio_job']), requested_model_tier: z.string().min(1).max(128).optional(),
}).strict();
const acceptedReceiptSchema = z.object({
  invocation_id: z.string().min(1).max(255), execution_id: z.string().min(1).max(255), accepted_provider_ref: z.string().min(1).max(255),
  accepted_at: z.string().datetime({ offset: true }), service_receipt: z.record(z.string(), z.unknown()), receipt_schema_version: z.string().min(1).max(32),
}).strict();
const executionEventSchema = z.object({
  event_id: z.string().min(1).max(255), event_type: z.enum(['execution.waiting', 'execution.accepted', 'execution.rejected', 'execution.failed', 'execution.unknown']),
  execution_id: z.string().min(1).max(255), invocation_id: z.string().min(1).max(255), occurred_at: z.string().datetime({ offset: true }),
  receipt_schema_version: z.string().min(1).max(32), receipt: z.record(z.string(), z.unknown()).optional(), signature: z.string().min(1).max(2048),
}).strict();
const targetSettlementSchema = z.object({ settlement_id: z.string().min(1), external_payment_ref: z.string().min(1), amount_minor: positiveDecimalString, currency: z.string().regex(/^[A-Z]{3}$/u), provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).optional() }).strict();
const targetRefundSchema = z.object({ settlement_id: z.string().min(1), external_ref: z.string().min(1), amount_minor: positiveDecimalString, allocation_mode: z.enum(['proportional', 'line_specific']), reason: z.string().min(1).max(500) }).strict();

const idempotencyKey = (request: FastifyRequest): string | null => {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const sendError = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
  const structured = error instanceof WebhookError
    ? { code: error.code, statusCode: error.statusCode }
    : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && 'statusCode' in error && typeof error.statusCode === 'number'
      ? { code: error.code, statusCode: error.statusCode }
      : null;
  const rawMessage = error instanceof Error ? error.message : 'billing.internal_error';
  const code = structured?.code ?? (rawMessage.startsWith('billing.') ? rawMessage : 'billing.internal_error');
  const status = structured?.statusCode !== undefined && structured.statusCode >= 400 && structured.statusCode < 500 ? structured.statusCode : code === 'billing.internal_error' ? 500
    : code === 'billing.insufficient_credit' ? 402
    : ['billing.idempotency_conflict', 'billing.command_in_progress', 'billing.command_unknown', 'billing.reversal_exposure', 'billing.credit_projection_drift', 'billing.usage_event_mismatch'].includes(code) ? 409
    : 400;
  return reply.code(status).send({ error: { code, message: code === 'billing.internal_error' ? 'internal billing error' : rawMessage } });
};

const requireIdempotency = (request: FastifyRequest, reply: Parameters<typeof sendError>[0]): string | null => {
  const value = idempotencyKey(request);
  if (!value) {
    void reply.code(400).send({ error: { code: 'billing.idempotency_required', message: 'Idempotency-Key is required' } });
    return null;
  }
  if (value.length < 8 || value.length > 128 || !/^[\x20-\x7E]+$/u.test(value)) {
    void reply.code(400).send({ error: { code: 'billing.idempotency_invalid', message: 'Idempotency-Key must be 8-128 printable characters' } });
    return null;
  }
  return value;
};

const claimIdempotencyHint = async (
  dependencies: BillingHttpDependencies,
  request: FastifyRequest,
  key: string,
  reply: Parameters<typeof sendError>[0],
  tenantId?: string,
): Promise<boolean> => {
  if (!dependencies.idempotencyHint) return true;
  const raw = request.rawBody ?? JSON.stringify(request.body ?? null);
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  const scopedKey = `${request.method}:${request.url}:${tenantId ?? String(request.headers['x-kokoro-tenant-id'] ?? '')}:${key}`;
  try {
    const claim = await dependencies.idempotencyHint.claim(scopedKey, fingerprint, 300);
    // Redis is only an early conflict detector. Replays continue to PostgreSQL, which remains
    // the authority and returns the durable result even after Redis TTL expiry.
    if (claim === 'conflict') {
      void reply.code(409).send({ error: { code: 'billing.idempotency_conflict', message: 'Idempotency-Key payload conflict' } });
      return false;
    }
  } catch {
    // Redis outage must not turn the fast-path hint into a billing availability dependency.
  }
  return true;
};

type StorefrontContext = BillingUserContext | BillingBffContext;

const hasStorefrontServiceMarker = (request: FastifyRequest): boolean => {
  return request.headers['x-kokoro-service'] !== undefined || request.headers['x-kokoro-internal-secret'] !== undefined;
};

/**
 * Storefront routes have two explicit authentication modes. A request that
 * presents an internal marker is never downgraded to the public user path.
 * This prevents forged or incomplete BFF headers from becoming a fixture/JWT
 * user request by accident.
 */
const storefrontContext = async (
  dependencies: BillingHttpDependencies,
  request: FastifyRequest,
  reply: Parameters<typeof sendError>[0],
): Promise<StorefrontContext | null> => {
  const serviceMarker = hasStorefrontServiceMarker(request);
  const bffContext = await dependencies.auth.bff(request);
  if (bffContext) return bffContext;
  if (serviceMarker) {
    void reply.code(403).send({ error: { code: 'billing.service_auth_failed', message: 'web BFF service authentication failed' } });
    return null;
  }
  const userContext = await dependencies.auth.user(request);
  if (userContext) return userContext;
  void reply.code(401).send({ error: { code: 'billing.unauthorized', message: 'user or web BFF context required' } });
  return null;
};

export const createBillingServer = (dependencies: BillingHttpDependencies): FastifyInstance => {
  const app = Fastify({
    logger: false,
    genReqId: (request) => {
      const incoming = request.headers['x-kokoro-request-id'];
      return typeof incoming === 'string' && /^[\x20-\x7E]{1,128}$/u.test(incoming) ? incoming : randomUUID();
    },
  });
  app.addHook('onRequest', (_request, _reply, done) => { runWithBillingContext(() => done()); });
  app.addHook('onRequest', async (request) => { request.billingStartedAt = process.hrtime.bigint(); });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split('?')[0] ?? 'unknown';
    const durationSeconds = request.billingStartedAt === undefined ? 0 : Number(process.hrtime.bigint() - request.billingStartedAt) / 1e9;
    recordHttpRequest({ method: request.method, route, statusCode: reply.statusCode, durationSeconds });
  });
  app.get('/healthz', async (_request, reply) => reply.code(200).send({ data: { module: 'kokoro-billing', status: 'ok' } }));
  app.get('/readyz', async (_request, reply) => {
    if (!dependencies.health) return reply.code(200).send({ data: { module: 'kokoro-billing', status: 'ready' } });
    try {
      await Promise.all([dependencies.health.postgres(), dependencies.health.redis()]);
      return reply.code(200).send({ data: { module: 'kokoro-billing', status: 'ready', dependencies: { postgres: 'ok', redis: 'ok' } } });
    } catch {
      return reply.code(503).send({ error: { code: 'billing.dependencies_not_ready', message: 'billing dependencies are not ready' } });
    }
  });
  registerMetricsRoute(app, 'billing');
  app.addHook('onSend', async (request, reply, payload) => {
    if (payload === null || payload === undefined) return payload;
    const raw = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null;
    if (raw === null) return payload;
    try {
      const body = JSON.parse(raw) as { error?: Record<string, unknown>; requestId?: string; meta?: Record<string, unknown> };
      reply.header('x-kokoro-request-id', request.id);
      const isV1Route = request.url.startsWith('/v1/');
      if (body.error !== undefined) {
        const error = body.error;
        const normalizedError = {
          ...error,
          request_id: error.request_id ?? request.id,
          retryable: error.retryable ?? (reply.statusCode >= 500 || reply.statusCode === 409 || reply.statusCode === 429),
          details: error.details ?? {},
        };
        if (isV1Route) {
          const v1Body = { ...body };
          delete v1Body.requestId;
          return JSON.stringify({ ...v1Body, error: normalizedError, meta: { ...(body.meta ?? {}), request_id: request.id } });
        }
        return JSON.stringify({ ...body, requestId: body.requestId ?? request.id, error: normalizedError });
      }
      if (reply.statusCode < 400 && isV1Route) {
        const v1Body = { ...body };
        delete v1Body.requestId;
        return JSON.stringify({ ...v1Body, meta: { ...(body.meta ?? {}), request_id: request.id } });
      }
      if (reply.statusCode < 400 && body.meta?.request_id === undefined) {
        return JSON.stringify({ ...body, meta: { ...(body.meta ?? {}), request_id: request.id } });
      }
    } catch {
      return payload;
    }
    return payload;
  });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = rawBody;
    try { done(null, JSON.parse(rawBody)); }
    catch { done(new Error('billing.invalid_json')); }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = rawBody;
    done(null, Object.fromEntries(new URLSearchParams(rawBody)));
  });

  // Canonical v1 transport. These routes expose the snake_case contract and
  // never accept a caller-selected account or amount for admission.
  const targetInternal = async (request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, allowed: readonly string[]): Promise<BillingInternalContext | null> => {
    const context = await dependencies.auth.internal(request);
    if (!context || !allowed.includes(context.serviceId)) {
      void reply.code(403).send({ error: { code: 'billing.forbidden', message: 'registered service identity required' } });
      return null;
    }
    return context;
  };
  const admissionWire = (result: BillingAdmissionResult) => ({
    admission_id: result.admissionId, hold_id: result.holdId, mode: result.mode,
    price_policy_revision_id: result.pricePolicyRevisionId, amount: result.amountMicros,
    currency: result.currency, status: result.status,
  });

  app.get('/v1/commerce/catalog', async (request, reply) => {
    const context = await storefrontContext(dependencies, request, reply);
    if (!context) return;
    if (!dependencies.catalog) return reply.code(503).send({ error: { code: 'billing.catalog_not_configured', message: 'catalog is not configured' } });
    try {
      const plans = await dependencies.catalog.listSellable(context.tenantId);
      return reply.code(200).send({ data: { offers: toSnakeCase(plans) }, requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/v1/billing/me/credit-account', async (request, reply) => {
    const context = await dependencies.auth.user(request);
    if (!context) return reply.code(401).send({ error: { code: 'billing.unauthorized', message: 'user context required' } });
    try {
      const account = await dependencies.account.getForSubject(context.tenantId, context.subjectId);
      if (!account) return reply.code(404).send({ error: { code: 'billing.not_found', message: 'credit account not found' } });
      return reply.code(200).send({ data: toSnakeCase(account), requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/v1/billing/me/credit-ledger', async (request, reply) => {
    const context = await dependencies.auth.user(request);
    if (!context) return reply.code(401).send({ error: { code: 'billing.unauthorized', message: 'user context required' } });
    if (!dependencies.accountRead) return reply.code(503).send({ error: { code: 'billing.account_read_not_configured', message: 'credit ledger is not configured' } });
    const parsed = ledgerPageQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    try {
      const ledger = await dependencies.accountRead.ledgerForSubject(context.tenantId, context.subjectId, parsed.data.limit, parsed.data.cursor);
      return reply.code(200).send({ data: toSnakeCase(ledger), requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/v1/billing/me/subscriptions', async (request, reply) => {
    const context = await dependencies.auth.user(request);
    if (!context) return reply.code(401).send({ error: { code: 'billing.unauthorized', message: 'user context required' } });
    if (!dependencies.subscriptionRead) return reply.code(503).send({ error: { code: 'billing.subscription_not_configured', message: 'subscription read is not configured' } });
    try {
      return reply.code(200).send({ data: { items: toSnakeCase(await dependencies.subscriptionRead.listForSubject(context.tenantId, context.subjectId)) }, requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/billing/checkout', async (request, reply) => {
    const context = await storefrontContext(dependencies, request, reply);
    if (!context) return;
    const subjectId = context.subjectId;
    if (subjectId === undefined) {
      return reply.code(403).send({ error: { code: 'billing.service_subject_required', message: 'web BFF subject context required for checkout' } });
    }
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = z.object({ offer_revision_id: z.string().min(1), amount_minor: positiveDecimalString, currency: z.string().regex(/^[A-Z]{3}$/u), quote_snapshot: z.record(z.string(), z.unknown()) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      const result = await dependencies.checkout.create({ offerRevisionId: parsed.data.offer_revision_id, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), currency: parsed.data.currency, quoteSnapshot: toCamelCase(parsed.data.quote_snapshot), tenantId: context.tenantId, subjectId, idempotencyKey: key, expiresAt: new Date(Date.now() + 300_000) });
      const hosted = dependencies.checkout.createHostedSession ? await dependencies.checkout.createHostedSession(context.tenantId, result.checkoutId) : result;
      return reply.code(201).send({ data: toSnakeCase({ ...hosted, amountMinor: String(hosted.amountMinor) }), requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/entitlement/admissions', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = admissionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      const result = await dependencies.admission.create({ tenantId: context.tenantId, billingSubject: parsed.data.billing_subject, payerRef: parsed.data.payer_ref, featureKey: parsed.data.feature_key, surface: parsed.data.surface, invocationId: parsed.data.invocation_id, executionId: parsed.data.execution_id, meterKind: parsed.data.meter_kind, ...(parsed.data.requested_model_tier === undefined ? {} : { requestedModelTier: parsed.data.requested_model_tier }), idempotencyKey: key });
      return reply.code(201).send({ data: admissionWire(result), requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { admissionId: string } }>('/v1/internal/entitlement/admissions/:admissionId/capture', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = acceptedReceiptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      const result = await dependencies.admission.capture(context.tenantId, request.params.admissionId, {
        invocationId: parsed.data.invocation_id, executionId: parsed.data.execution_id, acceptedProviderRef: parsed.data.accepted_provider_ref,
        acceptedAt: new Date(parsed.data.accepted_at), serviceReceipt: parsed.data.service_receipt, receiptSchemaVersion: parsed.data.receipt_schema_version,
      }, key);
      return reply.code(200).send({ data: admissionWire(result), requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { admissionId: string } }>('/v1/internal/entitlement/admissions/:admissionId/release', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const body = z.object({ invocation_id: z.string().min(1), reason: z.string().min(1).max(255), service_receipt: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: body.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      const result = await dependencies.admission.release(context.tenantId, request.params.admissionId, body.data.reason, key);
      return reply.code(200).send({ data: admissionWire(result), requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/billing/execution-events', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = executionEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      const result = await dependencies.admission.recordExecutionEvent({ tenantId: context.tenantId, eventId: parsed.data.event_id, eventType: parsed.data.event_type, executionId: parsed.data.execution_id, invocationId: parsed.data.invocation_id, occurredAt: new Date(parsed.data.occurred_at), receiptSchemaVersion: parsed.data.receipt_schema_version, signature: parsed.data.signature, ...(parsed.data.receipt === undefined ? {} : { receipt: parsed.data.receipt }) });
      return reply.code(202).send({ data: { event_id: result.eventId, status: result.status }, requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/payment/settlements/accept', async (request, reply) => {
    const context = await targetInternal(request, reply, ['payment-worker', 'scheduler']);
    if (!context) return;
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = targetSettlementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      await dependencies.settlement.recordSettlement({ settlementId: parsed.data.settlement_id, externalPaymentRef: parsed.data.external_payment_ref, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), currency: parsed.data.currency, tenantId: context.tenantId, ...(parsed.data.provider === undefined ? {} : { provider: parsed.data.provider }) });
      return reply.code(202).send({ data: { accepted: true }, requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/payment/refunds/accept', async (request, reply) => {
    const context = await targetInternal(request, reply, ['payment-worker']);
    if (!context) return;
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = targetRefundSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      const reversalId = await dependencies.reversal.recordReversal({ tenantId: context.tenantId, settlementId: parsed.data.settlement_id, externalReversalRef: parsed.data.external_ref, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), reason: `${parsed.data.allocation_mode}:${parsed.data.reason}`, idempotencyKey: key });
      return reply.code(202).send({ data: { refund_id: reversalId, status: 'accepted' }, requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/admin/billing/refunds', async (request, reply) => {
    const context = await dependencies.auth.admin(request);
    if (!context) return reply.code(403).send({ error: { code: 'billing.forbidden', message: 'admin role required' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = targetRefundSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    if (!(await claimIdempotencyHint(dependencies, request, key, reply, context.tenantId))) return;
    try {
      const refundId = await dependencies.reversal.recordReversal({ tenantId: context.tenantId, settlementId: parsed.data.settlement_id, externalReversalRef: parsed.data.external_ref, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), reason: `${parsed.data.allocation_mode}:${parsed.data.reason}`, idempotencyKey: key });
      return reply.code(202).send({ data: { refund_id: refundId, status: 'accepted' }, requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/commands/expire-credit-holds', async (request, reply) => {
    const context = await targetInternal(request, reply, ['scheduler']);
    if (!context) return;
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = z.object({ limit: z.number().int().positive().max(500).optional() }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    try {
      return reply.code(202).send({ data: toSnakeCase(await dependencies.usage.expireExpiredHolds(parsed.data.limit === undefined ? {} : { tenantId: context.tenantId, limit: parsed.data.limit })), requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { provider: string } }>('/v1/webhooks/payment/:provider', async (request, reply) => {
    if (!(await dependencies.auth.webhook(request))) return reply.code(401).send({ error: { code: 'billing.provider_event_invalid', message: 'provider signature required' } });
    const body = request.body as Record<string, unknown>;
    try {
      const parsed = dependencies.parseWebhook?.(request.params.provider, body);
      const providerAccountRef = parsed?.providerAccountRef ?? dependencies.resolveWebhookAccountRef?.(request.params.provider) ?? null;
      const tenantId = dependencies.resolveWebhookTenant
        ? providerAccountRef === null ? null : await dependencies.resolveWebhookTenant(request.params.provider, providerAccountRef)
        : typeof request.headers['x-kokoro-tenant-id'] === 'string' ? request.headers['x-kokoro-tenant-id'] : null;
      if (!tenantId) throw new Error('billing.tenant_mismatch');
      if (parsed?.payloadTenantId && parsed.payloadTenantId !== tenantId) throw new Error('billing.tenant_mismatch');
      const result = await dependencies.webhook.accept({ tenantId: tenantId, provider: request.params.provider, providerAccountRef, externalEventId: parsed?.eventId ?? String(body.id ?? ''), eventType: parsed?.eventType ?? String(body.type ?? 'unknown'), rawPayload: body, signatureValid: true });
      return reply.code(202).send({ data: { event_id: result.providerEventId, status: result.processingStatus }, requestId: request.id });
    } catch (error) { return sendError(reply, error); }
  });

  return app;
};

function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`), toSnakeCase(item)]));
}

function toCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key.replace(/_([a-z])/gu, (_match, character: string) => character.toUpperCase()), toCamelCase(item)]));
}
