import {
  Agent as HttpsAgent,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import type { Duplex } from "node:stream";
import Stripe from "stripe";
import type {
  HostedCheckoutInput,
  HostedCheckoutProvider,
  HostedCheckoutSession,
} from "../../application/checkout/ports/hosted-checkout-provider.js";

export type StripeTimeoutPolicy = Readonly<{
  connectTimeoutMs: number;
  readTimeoutMs: number;
  overallTimeoutMs: number;
}>;

const DEFAULT_STRIPE_TIMEOUT_POLICY: StripeTimeoutPolicy = {
  connectTimeoutMs: 3_000,
  readTimeoutMs: 10_000,
  overallTimeoutMs: 12_000,
};

class StripeConnectTimeoutAgent extends HttpsAgent {
  public constructor(private readonly connectTimeoutMs: number) {
    super({ keepAlive: true });
  }

  public override createConnection(
    options: HttpsRequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const stream = super.createConnection(options, callback);
    if (stream === null || stream === undefined) return stream;
    const timer = setTimeout(
      () => stream.destroy(new Error("billing.provider_connect_timeout")),
      this.connectTimeoutMs,
    );
    const clearConnectTimer = (): void => clearTimeout(timer);
    stream.once("secureConnect", clearConnectTimer);
    stream.once("error", clearConnectTimer);
    stream.once("close", clearConnectTimer);
    return stream;
  }
}

export class StripeCheckoutProvider implements HostedCheckoutProvider {
  public readonly provider = "stripe";
  private readonly stripe: Stripe;
  private readonly accountRef: string | null;
  private readonly overallTimeoutMs: number;

  public constructor(
    secretKey: string,
    accountRef?: string,
    timeouts: StripeTimeoutPolicy = DEFAULT_STRIPE_TIMEOUT_POLICY,
  ) {
    const httpAgent = new StripeConnectTimeoutAgent(timeouts.connectTimeoutMs);
    this.stripe = new Stripe(secretKey, {
      httpClient: Stripe.createNodeHttpClient(httpAgent),
      timeout: timeouts.readTimeoutMs,
      // This adapter only issues a checkout POST with a stable idempotency key.
      // Stripe retries retryable network/status failures and never an unkeyed mutation.
      maxNetworkRetries: 1,
    });
    this.accountRef = accountRef ?? null;
    this.overallTimeoutMs = timeouts.overallTimeoutMs;
  }

  public get providerAccountRef(): string | null {
    return this.accountRef;
  }

  public async createSession(
    input: HostedCheckoutInput,
  ): Promise<HostedCheckoutSession> {
    const metadata = {
      checkoutId: input.checkoutId,
      tenantId: input.tenantId,
      subjectId: input.subjectId,
    };
    const recurring =
      input.billingInterval === "once"
        ? undefined
        : { interval: input.billingInterval, interval_count: 1 };
    const sessionPromise = this.stripe.checkout.sessions.create(
      {
        mode: input.billingInterval === "once" ? "payment" : "subscription",
        line_items: [
          {
            price_data: {
              currency: input.currency.toLowerCase(),
              product_data: { name: input.productName },
              unit_amount: input.amountMinor,
              ...(recurring === undefined ? {} : { recurring }),
            },
            quantity: 1,
          },
        ],
        client_reference_id: input.checkoutId,
        metadata,
        ...(input.billingInterval === "once"
          ? { payment_intent_data: { metadata } }
          : { subscription_data: { metadata } }),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      {
        idempotencyKey: `billing-checkout:${input.checkoutId}`,
        ...(this.accountRef ? { stripeAccount: this.accountRef } : {}),
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("billing.provider_timeout")),
        this.overallTimeoutMs,
      );
    });
    let session: Stripe.Checkout.Session;
    try {
      session = await Promise.race([sessionPromise, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!session.url) throw new Error("billing.provider_checkout_url_missing");
    return {
      provider: this.provider,
      sessionId: session.id,
      checkoutUrl: session.url,
      providerAccountRef: this.accountRef,
    };
  }
}
