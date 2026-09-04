import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CheckoutService } from '../../application/checkout/commands/checkout-service.js';
import type { BillingSettlementService } from '../../application/payment/commands/billing-settlement-service.js';
import type { ProviderEventInboxService } from '../../application/payment/commands/provider-event-inbox-service.js';
import type { UsageSettlementService } from '../../application/metering/services/usage-settlement-service.js';
import type { CreditAccountQueryService } from '../../application/credit/services/account-query-service.js';
import type { BillingReversalService } from '../../application/refund/commands/billing-reversal-service.js';
import type { ParsedWebhookEvent } from '../../application/payment/ports/provider-types.js';
import type { CatalogService } from '../../application/checkout/services/catalog-service.js';
import type { SubscriptionQueryService } from '../../application/subscription/queries/subscription-query-service.js';
import type { IdempotencyHint } from '../../application/ports/idempotency-hint.js';
import type { BillingAdmissionService, BillingAdmissionResult } from '../../application/metering/services/billing-admission-service.js';
import { WebhookError } from '../../application/payment/ports/provider-types.js';
import { readSafeInteger } from '../../application/ports/safe-integer.js';
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
  readonly idempotencyHint?: IdempotencyHint;
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
  readonly subscriptionRead?: Pick<SubscriptionQueryService, 'listForSubject'>;
  readonly admission?: AdmissionPort;
  readonly auth: BillingAuth;
  readonly health?: { readonly postgres: () => Promise<void>; readonly redis: () => Promise<void> };
};

const decimalString = z.string().regex(/^(0|[1-9]\d*)$/u).refine((value) => Number.isSafeInteger(Number(value)), 'decimal value exceeds JavaScript safe integer range');
const positiveDecimalString = decimalString.refine((value) => BigInt(value) > 0n, 'value must be positive');
const safeDecimal = (value: string, field: string): number => readSafeInteger(value, field);
const pageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).optional() }).strict();
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
const releaseAdmissionSchema = z.object({
  invocation_id: z.string().min(1).max(255),
  reason: z.string().min(1).max(255),
  service_receipt: z.record(z.string(), z.unknown()).optional(),
}).strict();
const executionEventSchema = z.object({
  event_id: z.string().min(1).max(255), event_type: z.enum(['execution.waiting', 'execution.accepted', 'execution.rejected', 'execution.failed', 'execution.unknown']),
  execution_id: z.string().min(1).max(255), invocation_id: z.string().min(1).max(255), occurred_at: z.string().datetime({ offset: true }),
  receipt_schema_version: z.string().min(1).max(32), receipt: z.record(z.string(), z.unknown()).optional(),
}).strict();
const paymentProviderSchema = z.enum(['stripe', 'alipay', 'wechat']);
const targetSettlementSchema = z.object({ settlement_id: z.string().min(1).max(36), external_payment_ref: z.string().min(1).max(255), amount_minor: positiveDecimalString, currency: z.string().regex(/^[A-Z]{3}$/u), provider: paymentProviderSchema }).strict();
const expireCreditHoldsSchema = z.object({ batch_id: z.string().min(1).max(128), limit: z.number().int().positive().max(500).optional() }).strict();
const targetRefundSchema = z.object({ settlement_id: z.string().min(1), external_ref: z.string().min(1), amount_minor: positiveDecimalString, allocation_mode: z.enum(['proportional', 'line_specific']), reason: z.string().min(1).max(500) }).strict();
const unknownRecordSchema = z.record(z.string(), z.unknown());

const isUnknownRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const idempotencyKey = (request: FastifyRequest): string | null => {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

type ClassifiedBillingError = {
  readonly statusCode: number;
  readonly externalCode: string;
  readonly externalMessage: string;
  readonly internalCode: string;
};

export const classifyBillingError = (error: unknown): ClassifiedBillingError => {
  const structured = error instanceof WebhookError
    ? { code: error.code, statusCode: error.statusCode, internalCode: error.code }
    : error !== null && typeof error === 'object'
      && 'code' in error && typeof error.code === 'string'
      && 'statusCode' in error && typeof error.statusCode === 'number'
      ? {
          code: error.code,
          statusCode: error.statusCode,
          internalCode: 'internalCode' in error && typeof error.internalCode === 'string' ? error.internalCode : error.code,
        }
      : null;
  const rawMessage = error instanceof Error ? error.message : 'billing.internal_error';
  const code = structured?.code ?? (rawMessage.startsWith('billing.') ? rawMessage : 'billing.internal_error');
  const status = structured?.statusCode !== undefined && structured.statusCode >= 400 && structured.statusCode < 600 ? structured.statusCode : code === 'billing.internal_error' ? 500
    : code === 'billing.insufficient_credit' ? 402
    : ['billing.idempotency_conflict', 'billing.command_failed', 'billing.command_unknown', 'billing.reversal_exposure', 'billing.credit_projection_drift', 'billing.usage_event_mismatch'].includes(code) ? 409
    : 400;
  const internalCode = structured?.internalCode ?? code;
  if (status >= 500) {
    return { statusCode: status, externalCode: 'billing.internal_error', externalMessage: 'internal billing error', internalCode };
  }
  return { statusCode: status, externalCode: code, externalMessage: rawMessage, internalCode };
};

const sendError = (reply: FastifyReply, error: unknown) => {
  const classified = classifyBillingError(error);
  if (classified.statusCode >= 500) {
    reply.log.error({ err: error, internal_error_code: classified.internalCode }, 'billing request failed');
  }
  return reply.code(classified.statusCode).send({
    error: { code: classified.externalCode, message: classified.externalMessage },
  });
};

const requireIdempotency = (request: FastifyRequest, reply: FastifyReply): string | null => {
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

const markIdempotencyKeySeen = async (
  dependencies: BillingHttpDependencies,
  request: FastifyRequest,
  key: string,
  tenantId?: string,
): Promise<void> => {
  if (!dependencies.idempotencyHint) return;
  const scopedKey = `${request.method}:${request.url}:${tenantId ?? String(request.headers['x-kokoro-tenant-id'] ?? '')}:${key}`;
  try {
    await dependencies.idempotencyHint.markSeen(scopedKey, 300);
  } catch {
    // A lossy optimization never changes command availability or durable semantics.
  }
};

type StorefrontContext = BillingUserContext | BillingBffContext;

const hasStorefrontServiceMarker = (request: FastifyRequest): boolean => {
  return request.headers['x-kokoro-service'] !== undefined || request.headers['x-kokoro-internal-secret'] !== undefined;
};

/**
 * Storefront routes have two explicit authentication modes. A request that
 * presents an internal marker is never downgraded to the public user path.
 * This prevents forged or incomplete BFF headers from becoming an internal-header/JWT
 * user request by accident.
 */
const storefrontContext = async (
  dependencies: BillingHttpDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
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
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
      redact: {
        censor: '[REDACTED]',
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-kokoro-internal-secret"]',
          'req.headers["x-kokoro-service-token"]',
          'req.headers["stripe-signature"]',
          'req.headers["x-alipay-signature"]',
          'req.headers["wechatpay-signature"]',
        ],
      },
    },
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'request_id' }),
    forceCloseConnections: true,
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
    const incomingTraceId = request.headers['x-kokoro-trace-id'] ?? request.headers.traceparent;
    const traceId = typeof incomingTraceId === 'string' && /^[\x20-\x7E]{1,256}$/u.test(incomingTraceId) ? incomingTraceId : request.id;
    request.log.info({
      service: 'kokoro-billing',
      operation: `${request.method} ${route}`,
      request_id: request.id,
      trace_id: traceId,
      result: reply.statusCode < 400 ? 'success' : reply.statusCode < 500 ? 'client_error' : 'server_error',
      duration_ms: Number((durationSeconds * 1_000).toFixed(3)),
    }, 'billing request completed');
  });
  app.get('/healthz', async (_request, reply) => reply.code(200).send({ data: { module: 'kokoro-billing', status: 'ok' } }));
  app.get('/readyz', async (_request, reply) => {
    if (!dependencies.health) return reply.code(200).send({ data: { module: 'kokoro-billing', status: 'ready' } });
    try {
      await dependencies.health.postgres();
    } catch {
      return reply.code(503).send({ error: { code: 'billing.dependencies_not_ready', message: 'billing dependencies are not ready' } });
    }
    let redis: 'ok' | 'degraded' = 'ok';
    try {
      await dependencies.health.redis();
    } catch {
      redis = 'degraded';
    }
    return reply.code(200).send({ data: { module: 'kokoro-billing', status: 'ready', dependencies: { postgres: 'ok', redis } } });
  });
  registerMetricsRoute(app, 'billing');
  app.addHook('onSend', async (request, reply, payload) => {
    if (payload === null || payload === undefined) return payload;
    const raw = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null;
    if (raw === null) return payload;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isUnknownRecord(parsed)) return payload;
      const body = parsed;
      const meta = isUnknownRecord(body.meta) ? body.meta : {};
      reply.header('x-kokoro-request-id', request.id);
      if (isUnknownRecord(body.error)) {
        const error = body.error;
        const normalizedError = {
          ...error,
          retryable: error.retryable ?? (reply.statusCode >= 500 || reply.statusCode === 409 || reply.statusCode === 429),
          details: error.details ?? {},
        };
        return JSON.stringify({ ...body, error: normalizedError, meta: { ...meta, request_id: request.id } });
      }
      if (reply.statusCode < 400 && meta.request_id === undefined) {
        return JSON.stringify({ ...body, meta: { ...meta, request_id: request.id } });
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
    const parsed = pageQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message }, meta: { request_id: request.id } });
    try {
      const page = await dependencies.catalog.listSellable(context.tenantId, parsed.data.limit, parsed.data.cursor);
      return reply.code(200).send({ data: { offers: toSnakeCase(page.items), ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }) }, meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/v1/billing/me/credit-account', async (request, reply) => {
    const context = await dependencies.auth.user(request);
    if (!context) return reply.code(401).send({ error: { code: 'billing.unauthorized', message: 'user context required' } });
    try {
      const account = await dependencies.account.getForSubject(context.tenantId, context.subjectId);
      if (!account) return reply.code(404).send({ error: { code: 'billing.not_found', message: 'credit account not found' } });
      return reply.code(200).send({ data: toSnakeCase(account), meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/v1/billing/me/credit-ledger', async (request, reply) => {
    const context = await dependencies.auth.user(request);
    if (!context) return reply.code(401).send({ error: { code: 'billing.unauthorized', message: 'user context required' } });
    if (!dependencies.accountRead) return reply.code(503).send({ error: { code: 'billing.account_read_not_configured', message: 'credit ledger is not configured' } });
    const parsed = pageQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    try {
      const ledger = await dependencies.accountRead.ledgerForSubject(context.tenantId, context.subjectId, parsed.data.limit, parsed.data.cursor);
      return reply.code(200).send({ data: toSnakeCase(ledger), meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/v1/billing/me/subscriptions', async (request, reply) => {
    const context = await dependencies.auth.user(request);
    if (!context) return reply.code(401).send({ error: { code: 'billing.unauthorized', message: 'user context required' } });
    if (!dependencies.subscriptionRead) return reply.code(503).send({ error: { code: 'billing.subscription_not_configured', message: 'subscription read is not configured' } });
    const parsed = pageQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message }, meta: { request_id: request.id } });
    try {
      const page = await dependencies.subscriptionRead.listForSubject(context.tenantId, context.subjectId, parsed.data.limit, parsed.data.cursor);
      return reply.code(200).send({ data: { items: toSnakeCase(page.items), ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }) }, meta: { request_id: request.id } });
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
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const result = await dependencies.checkout.create({ offerRevisionId: parsed.data.offer_revision_id, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), currency: parsed.data.currency, quoteSnapshot: toCamelCase(parsed.data.quote_snapshot), tenantId: context.tenantId, subjectId, idempotencyKey: key, expiresAt: new Date(Date.now() + 300_000) });
      const hosted = dependencies.checkout.createHostedSession ? await dependencies.checkout.createHostedSession(context.tenantId, result.checkoutId) : result;
      return reply.code(201).send({ data: toSnakeCase({ ...hosted, amountMinor: String(hosted.amountMinor) }), meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/entitlement/admissions', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = admissionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const result = await dependencies.admission.create({ tenantId: context.tenantId, billingSubject: parsed.data.billing_subject, payerRef: parsed.data.payer_ref, featureKey: parsed.data.feature_key, surface: parsed.data.surface, invocationId: parsed.data.invocation_id, executionId: parsed.data.execution_id, meterKind: parsed.data.meter_kind, ...(parsed.data.requested_model_tier === undefined ? {} : { requestedModelTier: parsed.data.requested_model_tier }), idempotencyKey: key });
      return reply.code(201).send({ data: admissionWire(result), meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { admissionId: string } }>('/v1/internal/entitlement/admissions/:admissionId/capture', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = acceptedReceiptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const result = await dependencies.admission.capture(context.tenantId, request.params.admissionId, {
        invocationId: parsed.data.invocation_id, executionId: parsed.data.execution_id, acceptedProviderRef: parsed.data.accepted_provider_ref,
        acceptedAt: new Date(parsed.data.accepted_at), serviceReceipt: parsed.data.service_receipt, receiptSchemaVersion: parsed.data.receipt_schema_version,
      }, key);
      return reply.code(200).send({ data: admissionWire(result), meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { admissionId: string } }>('/v1/internal/entitlement/admissions/:admissionId/release', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const body = releaseAdmissionSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: body.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const result = await dependencies.admission.release({
        tenantId: context.tenantId,
        admissionId: request.params.admissionId,
        invocationId: body.data.invocation_id,
        reason: body.data.reason,
        ...(body.data.service_receipt === undefined ? {} : { serviceReceipt: body.data.service_receipt }),
        idempotencyKey: key,
      });
      return reply.code(200).send({ data: admissionWire(result), meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/billing/execution-events', async (request, reply) => {
    const context = await targetInternal(request, reply, ['agent', 'model', 'studio']);
    if (!context) return;
    if (!dependencies.admission) return reply.code(503).send({ error: { code: 'billing.admission_not_configured', message: 'admission is not configured' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = executionEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const result = await dependencies.admission.recordExecutionEvent({ tenantId: context.tenantId, eventId: parsed.data.event_id, eventType: parsed.data.event_type, executionId: parsed.data.execution_id, invocationId: parsed.data.invocation_id, occurredAt: new Date(parsed.data.occurred_at), receiptSchemaVersion: parsed.data.receipt_schema_version, ...(parsed.data.receipt === undefined ? {} : { receipt: parsed.data.receipt }), idempotencyKey: key });
      return reply.code(202).send({ data: { event_id: result.eventId, status: result.status }, meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/payment/settlements/accept', async (request, reply) => {
    const context = await targetInternal(request, reply, ['payment-worker', 'scheduler']);
    if (!context) return;
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = targetSettlementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const result = await dependencies.settlement.recordSettlement({ settlementId: parsed.data.settlement_id, externalPaymentRef: parsed.data.external_payment_ref, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), currency: parsed.data.currency, tenantId: context.tenantId, idempotencyKey: key, provider: parsed.data.provider });
      return reply.code(202).send({ data: { settlement_id: result.settlementId, accepted: result.accepted }, meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/payment/refunds/accept', async (request, reply) => {
    const context = await targetInternal(request, reply, ['payment-worker']);
    if (!context) return;
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = targetRefundSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const reversalId = await dependencies.reversal.recordReversal({ tenantId: context.tenantId, settlementId: parsed.data.settlement_id, externalReversalRef: parsed.data.external_ref, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), reason: `${parsed.data.allocation_mode}:${parsed.data.reason}`, idempotencyKey: key });
      return reply.code(202).send({ data: { refund_id: reversalId, status: 'accepted' }, meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/admin/billing/refunds', async (request, reply) => {
    const context = await dependencies.auth.admin(request);
    if (!context) return reply.code(403).send({ error: { code: 'billing.forbidden', message: 'admin role required' } });
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = targetRefundSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      const refundId = await dependencies.reversal.recordReversal({ tenantId: context.tenantId, settlementId: parsed.data.settlement_id, externalReversalRef: parsed.data.external_ref, amountMinor: safeDecimal(parsed.data.amount_minor, 'amount_minor'), reason: `${parsed.data.allocation_mode}:${parsed.data.reason}`, idempotencyKey: key, operatorId: context.operatorId });
      return reply.code(202).send({ data: { refund_id: refundId, status: 'accepted' }, meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/v1/internal/commands/expire-credit-holds', async (request, reply) => {
    const context = await targetInternal(request, reply, ['scheduler']);
    if (!context) return;
    const key = requireIdempotency(request, reply); if (!key) return;
    const parsed = expireCreditHoldsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: parsed.error.message } });
    await markIdempotencyKeySeen(dependencies, request, key, context.tenantId);
    try {
      return reply.code(202).send({ data: toSnakeCase(await dependencies.usage.expireExpiredHolds({ tenantId: context.tenantId, batchId: parsed.data.batch_id, idempotencyKey: key, ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }) })), meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { provider: string } }>('/v1/webhooks/payment/:provider', async (request, reply) => {
    const providerResult = paymentProviderSchema.safeParse(request.params.provider);
    if (!providerResult.success) return reply.code(400).send({ error: { code: 'billing.provider_not_supported', message: 'provider is not enabled by the production contract' } });
    const provider = providerResult.data;
    if (!(await dependencies.auth.webhook(request))) return reply.code(401).send({ error: { code: 'billing.provider_event_invalid', message: 'provider signature required' } });
    const parsedBody = unknownRecordSchema.safeParse(request.body);
    if (!parsedBody.success) return reply.code(400).send({ error: { code: 'billing.invalid_request', message: 'provider payload must be a JSON object' }, meta: { request_id: request.id } });
    const body = parsedBody.data;
    try {
      const parsed = dependencies.parseWebhook?.(provider, body);
      const providerAccountRef = parsed?.providerAccountRef ?? dependencies.resolveWebhookAccountRef?.(provider) ?? null;
      const tenantId = dependencies.resolveWebhookTenant
        ? providerAccountRef === null ? null : await dependencies.resolveWebhookTenant(provider, providerAccountRef)
        : typeof request.headers['x-kokoro-tenant-id'] === 'string' ? request.headers['x-kokoro-tenant-id'] : null;
      if (!tenantId) throw new Error('billing.tenant_mismatch');
      if (parsed?.payloadTenantId && parsed.payloadTenantId !== tenantId) throw new Error('billing.tenant_mismatch');
      const result = await dependencies.webhook.accept({ tenantId: tenantId, provider, providerAccountRef, externalEventId: parsed?.eventId ?? String(body.id ?? ''), eventType: parsed?.eventType ?? String(body.type ?? 'unknown'), rawPayload: body, signatureValid: true });
      return reply.code(202).send({ data: { event_id: result.providerEventId, status: result.processingStatus }, meta: { request_id: request.id } });
    } catch (error) { return sendError(reply, error); }
  });

  return app;
};

function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (!isUnknownRecord(value) || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`), toSnakeCase(item)]));
}

function toCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (!isUnknownRecord(value) || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/gu, (_match, character: string) => character.toUpperCase()), toCamelCase(item)]));
}
