import type { IncomingHttpHeaders } from 'node:http';
import type { ParsedWebhookEvent, PaymentWebhookProvider } from './provider-types.js';
import { AlipayWebhookProvider } from './providers/alipay/alipay-webhook-provider.js';
import { StripeWebhookProvider } from './providers/stripe/stripe-webhook-provider.js';
import { WechatWebhookProvider } from './providers/wechat/wechat-webhook-provider.js';
import { MockWebhookProvider } from './providers/mock/mock-webhook-provider.js';

export type PaymentProviderKind = 'stripe' | 'alipay' | 'wechat' | 'mock';
export type ProviderRegistry = ReadonlyMap<PaymentProviderKind, PaymentWebhookProvider>;
export type ProviderRegistryOptions = { readonly wechatApiV3Key?: string };

export const createProviderRegistry = (enabled: readonly PaymentProviderKind[] = [], options: ProviderRegistryOptions = {}): ProviderRegistry => {
  const factories: Record<PaymentProviderKind, () => PaymentWebhookProvider> = {
    stripe: () => new StripeWebhookProvider(),
    alipay: () => new AlipayWebhookProvider(),
    wechat: () => new WechatWebhookProvider(options.wechatApiV3Key ? { apiV3Key: options.wechatApiV3Key } : {}),
    mock: () => new MockWebhookProvider(),
  };
  return new Map(enabled.map((kind) => [kind, factories[kind]()]));
};

export const verifyProviderWebhook = (registry: ProviderRegistry, provider: string, headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean => {
  const adapter = registry.get(provider as PaymentProviderKind);
  return adapter?.verifySignature(headers, rawBody, secret) ?? false;
};

export const parseProviderWebhook = (registry: ProviderRegistry, provider: string, payload: unknown): ParsedWebhookEvent => {
  const adapter = registry.get(provider as PaymentProviderKind);
  if (!adapter) throw new Error('billing.provider_not_enabled');
  return adapter.parseEvent(payload);
};
