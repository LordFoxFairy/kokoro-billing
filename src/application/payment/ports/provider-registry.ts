import type { IncomingHttpHeaders } from "node:http";
import type {
  ParsedWebhookEvent,
  PaymentWebhookProvider,
} from "./provider-types.js";

/** Providers exposed by the production ingress contract. Test doubles stay under test/doubles. */
export type PaymentProviderKind = "stripe" | "alipay" | "wechat";
export type ProviderRegistry = ReadonlyMap<string, PaymentWebhookProvider>;

export const verifyProviderWebhook = (
  registry: ProviderRegistry,
  provider: string,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  secret: string,
): boolean => {
  const adapter = registry.get(provider);
  return adapter?.verifySignature(headers, rawBody, secret) ?? false;
};

export const parseProviderWebhook = (
  registry: ProviderRegistry,
  provider: string,
  payload: unknown,
): ParsedWebhookEvent => {
  const adapter = registry.get(provider);
  if (!adapter) throw new Error("billing.provider_not_enabled");
  return adapter.parseEvent(payload);
};
