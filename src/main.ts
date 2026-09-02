import { createBillingConnection } from './infrastructure/postgres/connection.js';
import { BillingSettlementService } from './modules/payment/billing-settlement-service.js';
import { CheckoutService } from './modules/payment/checkout-service.js';
import { ProviderEventInboxService } from './modules/payment/provider-event-inbox-service.js';
import { BillingReversalService } from './modules/payment/billing-reversal-service.js';
import { UsageSettlementService } from './modules/metering/usage-settlement-service.js';
import { CreditAccountQueryService } from './modules/credit/account-query-service.js';
import { createBillingServer } from './interfaces/http/server.js';
import { createProviderRegistry, parseProviderWebhook, verifyProviderWebhook } from './modules/payment/provider-registry.js';
import { CatalogService } from './modules/catalog/catalog-service.js';
import { RedisIdempotencyHint } from './infrastructure/redis/idempotency-hint.js';
import { StripeCheckoutProvider } from './infrastructure/providers/stripe-checkout-provider.js';
import { assertProviderWebhookSecrets, assertWechatApiV3Key, readEnabledProviders, readProviderWebhookSecrets } from './modules/payment/provider-config.js';
import { createBillingAuth } from './infrastructure/auth/billing-auth.js';
import { ProviderAccountService } from './modules/payment/provider-account-service.js';
import { BillingAdmissionService } from './modules/metering/billing-admission-service.js';
import { SubscriptionQueryService } from './modules/payment/subscription-query-service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET;
if (!internalServiceSecret) throw new Error('INTERNAL_SERVICE_SECRET is required');
const rawAuthMode = process.env.BILLING_AUTH_MODE ?? 'header-fixture';
if (rawAuthMode !== 'header-fixture' && rawAuthMode !== 'jwks') throw new Error('BILLING_AUTH_MODE must be header-fixture or jwks');
const authMode: 'header-fixture' | 'jwks' = rawAuthMode;
if (process.env.NODE_ENV === 'production' && authMode !== 'jwks') throw new Error('BILLING_AUTH_MODE=jwks is required in production');
const operatorProxySecret = process.env.BILLING_OPERATOR_PROXY_SECRET ?? (authMode === 'header-fixture' ? internalServiceSecret : undefined);
if (!operatorProxySecret) throw new Error('BILLING_OPERATOR_PROXY_SECRET is required outside the local fixture mode');

const connection = await createBillingConnection(databaseUrl);
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required');
const enabledProviders = readEnabledProviders();
const idempotencyHint = new RedisIdempotencyHint(redisUrl);
await idempotencyHint.connect();
const checkout = new CheckoutService(connection, {
  mockEnabled: enabledProviders.includes('mock'),
  ...(enabledProviders.includes('stripe') && process.env.STRIPE_SECRET_KEY ? { hostedProvider: new StripeCheckoutProvider(process.env.STRIPE_SECRET_KEY, process.env.BILLING_PROVIDER_ACCOUNT_REF_STRIPE), publicBaseUrl: process.env.BILLING_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000' } : {}),
});
const catalog = new CatalogService(connection);
const settlement = new BillingSettlementService(connection);
const usage = new UsageSettlementService(connection);
const admission = new BillingAdmissionService(connection, usage);
const subscriptions = new SubscriptionQueryService(connection);
const webhook = new ProviderEventInboxService(connection);
const providerAccounts = new ProviderAccountService(connection);
const reversal = new BillingReversalService(connection);
const account = new CreditAccountQueryService(connection);
const providerSecrets = readProviderWebhookSecrets();
assertProviderWebhookSecrets(enabledProviders, providerSecrets);
assertWechatApiV3Key(enabledProviders);
const providerRegistry = createProviderRegistry(enabledProviders, process.env.WECHAT_API_V3_KEY ? { wechatApiV3Key: process.env.WECHAT_API_V3_KEY } : {});
const auth = createBillingAuth({
  mode: authMode,
  internalServiceSecret,
  // The current BFF emits one upstream credential in both the internal-secret
  // header and the Authorization bearer. Keep the fallback for that deployed
  // shape while allowing a separately rotated bearer when the BFF is configured
  // to send one.
  ...(process.env.BILLING_BFF_SERVICE_TOKEN ? { bffServiceToken: process.env.BILLING_BFF_SERVICE_TOKEN } : {}),
  operatorProxySecret,
  ...(process.env.BILLING_AUTH_JWKS_URL ? { jwksUrl: process.env.BILLING_AUTH_JWKS_URL } : {}),
  issuer: process.env.BILLING_AUTH_JWT_ISSUER ?? 'kokoro-iam',
  ...(process.env.BILLING_AUTH_JWT_AUDIENCE ? { audience: process.env.BILLING_AUTH_JWT_AUDIENCE } : {}),
});
const server = createBillingServer({
  idempotencyHint,
  catalog,
  checkout,
  settlement,
  reversal,
  usage,
  admission,
  subscriptionRead: subscriptions,
  webhook,
  parseWebhook: (provider, payload) => parseProviderWebhook(providerRegistry, provider, payload),
  // Production JWKS mode uses the provider-account registry as the sole tenant
  // authority. Local header-fixture mode intentionally keeps the mock webhook
  // fixture usable without provisioning a provider-account row.
  ...(authMode === 'jwks' ? { resolveWebhookTenant: (provider: string, externalAccountRef: string) => providerAccounts.resolveTenantId(provider, externalAccountRef) } : {}),
  account,
  accountRead: account,
  auth: {
    ...auth,
    webhook: async (request) => {
      const provider = (request.params as { provider?: string }).provider;
      const secret = typeof provider === 'string' ? providerSecrets[provider] : undefined;
      // Each provider owns its canonical signature input: Stripe/WeChat use
      // headers plus raw bytes, Alipay signs form fields in the body, and the
      // local mock uses its own fixture header. Do not impose one shared
      // header requirement at the HTTP adapter boundary.
      return typeof provider === 'string' && typeof secret === 'string' && verifyProviderWebhook(providerRegistry, provider, request.headers, Buffer.from(request.rawBody ?? ''), secret);
    },
  },
  resolveWebhookAccountRef: (provider) => process.env[`BILLING_PROVIDER_ACCOUNT_REF_${provider.toUpperCase()}`] ?? null,
  health: {
    postgres: async () => { await connection.ping(); },
    redis: async () => { await idempotencyHint.ping(); },
  },
});

const port = Number(process.env.BILLING_PORT ?? 4245);
await server.listen({ host: process.env.BILLING_HOST ?? '127.0.0.1', port });

let shutdownPromise: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await server.close();
    await idempotencyHint.close();
    await connection.end();
  })();
  return shutdownPromise;
};
process.once('SIGTERM', () => { void shutdown().catch((error: unknown) => { process.stderr.write(`kokoro-billing shutdown failed error=${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }); });
process.once('SIGINT', () => { void shutdown().catch((error: unknown) => { process.stderr.write(`kokoro-billing shutdown failed error=${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }); });
