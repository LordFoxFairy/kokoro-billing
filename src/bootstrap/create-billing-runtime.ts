import type { FastifyInstance } from 'fastify';
import { createBillingConnection } from '../infrastructure/postgres/connection.js';
import { createBillingServer } from '../interfaces/http/server.js';
import { parseProviderWebhook, verifyProviderWebhook } from '../application/payment/ports/provider-registry.js';
import { createProviderRegistry } from '../infrastructure/providers/payment/provider-registry.js';
import { RedisIdempotencyHint } from '../infrastructure/redis/idempotency-hint.js';
import { StripeCheckoutProvider } from '../infrastructure/providers/stripe-checkout-provider.js';
import { createBillingAuth } from '../infrastructure/auth/billing-auth.js';
import type { BillingRuntimeConfig } from '../config/runtime-config.js';
import {
  createPostgresBillingAdmissionService,
  createPostgresBillingReversalService,
  createPostgresBillingSettlementService,
  createPostgresCatalogService,
  createPostgresCheckoutService,
  createPostgresCreditAccountQueryService,
  createPostgresProviderAccountService,
  createPostgresProviderEventInboxService,
  createPostgresSubscriptionQueryService,
  createPostgresUsageSettlementService,
} from '../infrastructure/postgres/create-postgres-services.js';

export type BillingRuntime = Readonly<{
  server: FastifyInstance;
  close: () => Promise<void>;
}>;

/** Composition root for PostgreSQL, Redis, provider adapters, application services and HTTP. */
export async function createBillingRuntime(config: BillingRuntimeConfig): Promise<BillingRuntime> {
  const connection = await createBillingConnection(config.databaseUrl);
  const idempotencyHint = new RedisIdempotencyHint(config.redisUrl, 'billing:idempotency', config.redisTimeouts);

  try {
    try {
      await idempotencyHint.connect();
    } catch (error) {
      process.stderr.write(`kokoro-billing redis hint unavailable during startup error=${error instanceof Error ? error.message : String(error)}\n`);
    }

    const checkout = createPostgresCheckoutService(connection, {
      ...(config.enabledProviders.includes('stripe') && config.stripeSecretKey
        ? {
            hostedProvider: new StripeCheckoutProvider(config.stripeSecretKey, config.stripeAccountRef, config.stripeTimeouts),
            publicBaseUrl: config.publicBaseUrl,
          }
        : {}),
    });
    const catalog = createPostgresCatalogService(connection);
    const settlement = createPostgresBillingSettlementService(connection);
    const usage = createPostgresUsageSettlementService(connection);
    const admission = createPostgresBillingAdmissionService(connection, usage);
    const subscriptions = createPostgresSubscriptionQueryService(connection);
    const webhook = createPostgresProviderEventInboxService(connection);
    const providerAccounts = createPostgresProviderAccountService(connection);
    const reversal = createPostgresBillingReversalService(connection);
    const account = createPostgresCreditAccountQueryService(connection);
    const providerRegistry = createProviderRegistry(
      config.enabledProviders,
      config.wechatApiV3Key === undefined ? {} : { wechatApiV3Key: config.wechatApiV3Key },
    );
    const auth = createBillingAuth({
      mode: config.authMode,
      internalServiceSecret: config.internalServiceSecret,
      bffServiceToken: config.bffServiceToken,
      operatorProxySecret: config.operatorProxySecret,
      ...(config.jwksUrl === undefined ? {} : { jwksUrl: config.jwksUrl }),
      issuer: config.issuer,
      ...(config.audience === undefined ? {} : { audience: config.audience }),
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
      ...(config.authMode === 'jwks'
        ? { resolveWebhookTenant: (provider: string, externalAccountRef: string) => providerAccounts.resolveTenantId(provider, externalAccountRef) }
        : {}),
      account,
      accountRead: account,
      auth: {
        ...auth,
        webhook: async (request) => {
          const params: unknown = request.params;
          const provider = params !== null && typeof params === 'object' && 'provider' in params && typeof params.provider === 'string'
            ? params.provider
            : undefined;
          const secret = typeof provider === 'string' ? config.providerSecrets[provider] : undefined;
          return typeof provider === 'string'
            && typeof secret === 'string'
            && verifyProviderWebhook(providerRegistry, provider, request.headers, Buffer.from(request.rawBody ?? ''), secret);
        },
      },
      resolveWebhookAccountRef: (provider) => config.providerAccountRefs[provider] ?? null,
      health: {
        postgres: () => connection.ping(),
        redis: () => idempotencyHint.ping(),
      },
    });

    let closed = false;
    return {
      server,
      close: async () => {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([server.close(), idempotencyHint.close(), connection.end()]);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) throw new Error(`${failures.length} billing resources failed to close`);
      },
    };
  } catch (error) {
    await idempotencyHint.close();
    await connection.end();
    throw error;
  }
}
