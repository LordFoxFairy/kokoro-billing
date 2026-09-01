import Stripe from 'stripe';
import type { HostedCheckoutInput, HostedCheckoutProvider, HostedCheckoutSession } from '../../modules/payment/hosted-checkout-provider.js';

export class StripeCheckoutProvider implements HostedCheckoutProvider {
  public readonly provider = 'stripe';
  private readonly stripe: Stripe;
  private readonly accountRef: string | null;

  public constructor(secretKey: string, accountRef?: string) { this.stripe = new Stripe(secretKey); this.accountRef = accountRef ?? null; }

  public get providerAccountRef(): string | null { return this.accountRef; }

  public async createSession(input: HostedCheckoutInput): Promise<HostedCheckoutSession> {
    const metadata = { checkoutId: input.checkoutId, tenantId: input.tenantId, subjectId: input.subjectId };
    const recurring = input.billingInterval === 'once' ? undefined : { interval: input.billingInterval, interval_count: 1 };
    const session = await this.stripe.checkout.sessions.create({
      mode: input.billingInterval === 'once' ? 'payment' : 'subscription',
      line_items: [{ price_data: { currency: input.currency.toLowerCase(), product_data: { name: input.productName }, unit_amount: input.amountMinor, ...(recurring === undefined ? {} : { recurring }) }, quantity: 1 }],
      client_reference_id: input.checkoutId,
      metadata,
      ...(input.billingInterval === 'once' ? { payment_intent_data: { metadata } } : { subscription_data: { metadata } }),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }, { idempotencyKey: `billing-checkout:${input.checkoutId}`, ...(this.accountRef ? { stripeAccount: this.accountRef } : {}) });
    if (!session.url) throw new Error('billing.provider_checkout_url_missing');
    return { provider: this.provider, sessionId: session.id, checkoutUrl: session.url, providerAccountRef: this.accountRef };
  }
}
