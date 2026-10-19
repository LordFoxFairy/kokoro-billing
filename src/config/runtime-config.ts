export type BillingAuthMode = "internal-header" | "jwks";
export const BILLING_DATABASE_SCHEMA = "kokoro_billing";
export const BILLING_DATABASE_SEARCH_PATH = `${BILLING_DATABASE_SCHEMA},pg_catalog`;

export function parseBillingDatabaseUrl(
  raw: string,
  name = "DATABASE_URL",
): URL {
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error(`${name} must be a PostgreSQL connection string`);
  const schemas = url.searchParams.getAll("schema");
  if (schemas.length !== 1 || schemas[0] !== BILLING_DATABASE_SCHEMA)
    throw new Error(
      `${name} must contain exactly one schema=${BILLING_DATABASE_SCHEMA}`,
    );
  if (url.searchParams.has("options"))
    throw new Error(`${name} must not contain PostgreSQL options`);
  return url;
}

export type DependencyTimeoutConfig = Readonly<{
  connectTimeoutMs: number;
  readTimeoutMs: number;
  overallTimeoutMs: number;
}>;

export type BillingRuntimeConfig = Readonly<{
  databaseUrl: string;
  auth: BillingPersonalHttpOptions;
  shutdownDeadlineMs: number;
  host: string;
  port: number;
}>;

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
};

const readPort = (env: NodeJS.ProcessEnv): number => {
  const raw = env.BILLING_PORT ?? "4245";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("BILLING_PORT must be an integer between 1 and 65535");
  return port;
};

const readPositiveMilliseconds = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
};

const readAuthMode = (env: NodeJS.ProcessEnv): BillingAuthMode => {
  const raw = env.BILLING_AUTH_MODE ?? "internal-header";
  if (raw !== "internal-header" && raw !== "jwks")
    throw new Error("BILLING_AUTH_MODE must be internal-header or jwks");
  if (env.NODE_ENV === "production" && raw !== "jwks")
    throw new Error("BILLING_AUTH_MODE=jwks is required in production");
  return raw;
};

export const readBillingRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env,
): BillingRuntimeConfig => {
  return Object.freeze({
    databaseUrl: parseBillingDatabaseUrl(
      required(env, "DATABASE_URL"),
    ).toString(),
    auth: readBillingPersonalHttpOptions(env),
    shutdownDeadlineMs: readPositiveMilliseconds(
      env,
      "BILLING_SHUTDOWN_DEADLINE_MS",
      10_000,
    ),
    host: env.BILLING_HOST ?? "127.0.0.1",
    port: readPort(env),
  });
};

import type {
  BillingAuthOptions,
  BillingPersonalHttpOptions,
} from "../infrastructure/auth/billing-auth.types.js";

export function validateBillingPersonalHttpOptions(
  options: BillingAuthOptions,
): BillingPersonalHttpOptions {
  if (
    options.mode !== "jwks" ||
    options.jwksUrl === undefined ||
    options.audience === undefined ||
    options.issuer.trim().length === 0 ||
    options.audience.trim().length === 0
  )
    throw new Error(
      "Personal Billing HTTP requires explicit JWKS, issuer and audience",
    );
  for (const value of [
    options.internalServiceSecret,
    options.bffServiceToken,
    options.operatorProxySecret,
  ]) {
    if (!/^[!-~]{32,4096}$/u.test(value))
      throw new Error(
        "Personal Billing HTTP requires explicit strong service credentials",
      );
  }
  if (
    new Set([
      options.operatorProxySecret,
      options.internalServiceSecret,
      options.bffServiceToken,
    ]).size !== 3
  )
    throw new Error(
      "Personal Billing HTTP credentials must have distinct roles",
    );
  const url = new URL(options.jwksUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Personal Billing HTTP requires a valid JWKS endpoint");
  return Object.freeze({
    ...options,
    mode: "jwks",
    jwksUrl: options.jwksUrl,
    audience: options.audience,
  });
}
export function readBillingPersonalHttpOptions(
  env: NodeJS.ProcessEnv = process.env,
): BillingPersonalHttpOptions {
  return validateBillingPersonalHttpOptions({
    mode: readAuthMode(env),
    internalServiceSecret: required(env, "INTERNAL_SERVICE_SECRET"),
    bffServiceToken: required(env, "BILLING_BFF_SERVICE_TOKEN"),
    operatorProxySecret: required(env, "BILLING_OPERATOR_PROXY_SECRET"),
    jwksUrl: required(env, "BILLING_AUTH_JWKS_URL"),
    issuer: required(env, "BILLING_AUTH_JWT_ISSUER"),
    audience: required(env, "BILLING_AUTH_JWT_AUDIENCE"),
  });
}
