import type { PaymentProviderKind } from '../application/payment/ports/provider-registry.js';
import {
  ALL_PAYMENT_PROVIDERS,
  assertProviderWebhookSecrets,
  assertWechatApiV3Key,
  readEnabledProviders,
  readProviderWebhookSecrets,
} from './provider-config.js';

export type BillingAuthMode = 'internal-header' | 'jwks';
export type DependencyTimeoutConfig = Readonly<{
  connectTimeoutMs: number;
  readTimeoutMs: number;
  overallTimeoutMs: number;
}>;

export type BillingRuntimeConfig = {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly authMode: BillingAuthMode;
  readonly internalServiceSecret: string;
  readonly bffServiceToken: string;
  readonly operatorProxySecret: string;
  readonly jwksUrl?: string;
  readonly issuer: string;
  readonly audience?: string;
  readonly enabledProviders: readonly PaymentProviderKind[];
  readonly providerSecrets: Readonly<Record<string, string>>;
  readonly wechatApiV3Key?: string;
  readonly stripeSecretKey?: string;
  readonly stripeAccountRef?: string;
  readonly providerAccountRefs: Readonly<Record<string, string | null>>;
  readonly publicBaseUrl: string;
  readonly redisTimeouts: DependencyTimeoutConfig;
  readonly stripeTimeouts: DependencyTimeoutConfig;
  readonly shutdownDeadlineMs: number;
  readonly host: string;
  readonly port: number;
};

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};

const readPort = (env: NodeJS.ProcessEnv): number => {
  const raw = env.BILLING_PORT ?? '4245';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('BILLING_PORT must be an integer between 1 and 65535');
  return port;
};

const readPositiveMilliseconds = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
};

const readTimeouts = (
  env: NodeJS.ProcessEnv,
  prefix: 'REDIS' | 'STRIPE',
  defaults: DependencyTimeoutConfig,
): DependencyTimeoutConfig => {
  const timeouts = {
    connectTimeoutMs: readPositiveMilliseconds(env, `${prefix}_CONNECT_TIMEOUT_MS`, defaults.connectTimeoutMs),
    readTimeoutMs: readPositiveMilliseconds(env, `${prefix}_READ_TIMEOUT_MS`, defaults.readTimeoutMs),
    overallTimeoutMs: readPositiveMilliseconds(env, `${prefix}_OVERALL_TIMEOUT_MS`, defaults.overallTimeoutMs),
  };
  if (timeouts.overallTimeoutMs < Math.max(timeouts.connectTimeoutMs, timeouts.readTimeoutMs)) {
    throw new Error(`${prefix}_OVERALL_TIMEOUT_MS must be at least the connect and read timeouts`);
  }
  return timeouts;
};

const readAuthMode = (env: NodeJS.ProcessEnv): BillingAuthMode => {
  const raw = env.BILLING_AUTH_MODE ?? 'internal-header';
  if (raw !== 'internal-header' && raw !== 'jwks') throw new Error('BILLING_AUTH_MODE must be internal-header or jwks');
  if (env.NODE_ENV === 'production' && raw !== 'jwks') throw new Error('BILLING_AUTH_MODE=jwks is required in production');
  return raw;
};

export const readBillingRuntimeConfig = (env: NodeJS.ProcessEnv = process.env): BillingRuntimeConfig => {
  const databaseUrl = required(env, 'DATABASE_URL');
  const redisUrl = required(env, 'REDIS_URL');
  const internalServiceSecret = required(env, 'INTERNAL_SERVICE_SECRET');
  const bffServiceToken = required(env, 'BILLING_BFF_SERVICE_TOKEN');
  const operatorProxySecret = required(env, 'BILLING_OPERATOR_PROXY_SECRET');
  const authMode = readAuthMode(env);
  const jwksUrl = env.BILLING_AUTH_JWKS_URL;
  if (authMode === 'jwks' && (jwksUrl === undefined || jwksUrl.length === 0)) throw new Error('BILLING_AUTH_JWKS_URL is required');

  const enabledProviders = readEnabledProviders(env.BILLING_ENABLED_PROVIDERS ?? '');
  const providerSecrets = readProviderWebhookSecrets(env.PROVIDER_WEBHOOK_SECRETS_JSON ?? '{}');
  assertProviderWebhookSecrets(enabledProviders, providerSecrets);
  const wechatApiV3Key = env.WECHAT_API_V3_KEY;
  assertWechatApiV3Key(enabledProviders, wechatApiV3Key ?? '');
  const redisTimeouts = readTimeouts(env, 'REDIS', { connectTimeoutMs: 2_000, readTimeoutMs: 1_000, overallTimeoutMs: 3_000 });
  const stripeTimeouts = readTimeouts(env, 'STRIPE', { connectTimeoutMs: 3_000, readTimeoutMs: 10_000, overallTimeoutMs: 12_000 });

  const providerAccountRefs: Record<string, string | null> = {};
  for (const provider of ALL_PAYMENT_PROVIDERS) {
    providerAccountRefs[provider] = env[`BILLING_PROVIDER_ACCOUNT_REF_${provider.toUpperCase()}`] ?? null;
  }

  return {
    databaseUrl,
    redisUrl,
    authMode,
    internalServiceSecret,
    bffServiceToken,
    operatorProxySecret,
    ...(jwksUrl === undefined ? {} : { jwksUrl }),
    issuer: env.BILLING_AUTH_JWT_ISSUER ?? 'kokoro-iam',
    ...(env.BILLING_AUTH_JWT_AUDIENCE === undefined ? {} : { audience: env.BILLING_AUTH_JWT_AUDIENCE }),
    enabledProviders,
    providerSecrets,
    ...(wechatApiV3Key === undefined ? {} : { wechatApiV3Key }),
    ...(env.STRIPE_SECRET_KEY === undefined ? {} : { stripeSecretKey: env.STRIPE_SECRET_KEY }),
    ...(providerAccountRefs.stripe === null ? {} : { stripeAccountRef: providerAccountRefs.stripe }),
    providerAccountRefs,
    publicBaseUrl: env.BILLING_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000',
    redisTimeouts,
    stripeTimeouts,
    shutdownDeadlineMs: readPositiveMilliseconds(env, 'BILLING_SHUTDOWN_DEADLINE_MS', 10_000),
    host: env.BILLING_HOST ?? '127.0.0.1',
    port: readPort(env),
  };
};
