import type { PaymentProviderKind, ProviderRegistry } from '../../../application/payment/ports/provider-registry.js';
import type { PaymentWebhookProvider } from '../../../application/payment/ports/provider-types.js';
import { AlipayWebhookProvider } from './adapters/alipay/alipay-webhook-provider.js';
import { StripeWebhookProvider } from './adapters/stripe/stripe-webhook-provider.js';
import { WechatWebhookProvider } from './adapters/wechat/wechat-webhook-provider.js';

export type ProviderRegistryOptions = { readonly wechatApiV3Key?: string };

/** Composition-root factory: infrastructure owns concrete provider adapters. */
export const createProviderRegistry = (enabled: readonly PaymentProviderKind[] = [], options: ProviderRegistryOptions = {}): ProviderRegistry => {
  const factories: Record<PaymentProviderKind, () => PaymentWebhookProvider> = {
    stripe: () => new StripeWebhookProvider(),
    alipay: () => new AlipayWebhookProvider(),
    wechat: () => new WechatWebhookProvider(options.wechatApiV3Key ? { apiV3Key: options.wechatApiV3Key } : {}),
  };
  return new Map(enabled.map((kind) => [kind, factories[kind]() ]));
};
