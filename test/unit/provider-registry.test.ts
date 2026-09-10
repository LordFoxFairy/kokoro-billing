import { describe, expect, it } from "vitest";
import {
  createCipheriv,
  createHmac,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  parseProviderWebhook,
  verifyProviderWebhook,
} from "../../src/application/payment/ports/provider-registry.js";
import { createProviderRegistry } from "../../src/infrastructure/providers/payment/provider-registry.js";
import {
  signStripeWebhook,
  StripeWebhookProvider,
} from "../../src/infrastructure/providers/payment/adapters/stripe/stripe-webhook-provider.js";
import { WechatWebhookProvider } from "../../src/infrastructure/providers/payment/adapters/wechat/wechat-webhook-provider.js";
import {
  AlipayWebhookProvider,
  signAlipayNotification,
} from "../../src/infrastructure/providers/payment/adapters/alipay/alipay-webhook-provider.js";
import { MockWebhookProvider } from "../doubles/payment/mock-webhook-provider.js";

describe("payment provider registry", () => {
  it("reuses the mature Stripe adapter only when explicitly enabled", () => {
    const registry = createProviderRegistry(["stripe"]);
    const rawBody = Buffer.from(
      JSON.stringify({ id: "evt-1", type: "unknown", data: {} }),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signStripeWebhook(rawBody, "secret", timestamp);
    expect(
      verifyProviderWebhook(
        registry,
        "stripe",
        { "stripe-signature": signature },
        rawBody,
        "secret",
      ),
    ).toBe(true);
    expect(
      verifyProviderWebhook(registry, "wechat", {}, rawBody, "secret"),
    ).toBe(false);
  });

  it("treats Stripe Checkout Session completion as the canonical acquisition event", () => {
    const event = new StripeWebhookProvider().parseEvent({
      id: "evt-checkout-1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs-1",
          payment_intent: "pi-1",
          metadata: { checkoutId: "checkout-stripe-1", tenantId: "tenant-1" },
        },
      },
    });
    expect(event).toMatchObject({
      eventId: "evt-checkout-1",
      orderId: "checkout-stripe-1",
      payloadTenantId: "tenant-1",
      externalPaymentRef: "pi-1",
    });
    expect(
      new StripeWebhookProvider().parseEvent({
        id: "evt-payment-intent-1",
        type: "payment_intent.succeeded",
        data: {
          object: { id: "pi-1", metadata: { checkoutId: "checkout-stripe-1" } },
        },
      }),
    ).toMatchObject({
      eventType: "payment_intent.succeeded",
      orderId: null,
      payloadTenantId: null,
      externalPaymentRef: null,
    });
  });

  it("uses the latest Stripe refund fact instead of cumulative charge.amount_refunded", () => {
    const provider = new StripeWebhookProvider();
    expect(
      provider.parseEvent({
        id: "evt-refund",
        type: "charge.refunded",
        account: "acct-1",
        data: {
          object: {
            id: "ch-1",
            amount_refunded: 1500,
            refunds: { data: [{ id: "re-2", amount: 500 }] },
            metadata: { checkoutId: "checkout-1" },
          },
        },
      }),
    ).toMatchObject({ externalReversalRef: "re-2", refundAmountMinor: 500 });
  });

  it("does not turn recurring Stripe callbacks into one-time credit grants", () => {
    const provider = new StripeWebhookProvider();
    expect(
      provider.parseEvent({
        id: "evt-session-subscription",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs-1",
            subscription: "sub-1",
            metadata: { checkoutId: "checkout-1" },
          },
        },
      }),
    ).toMatchObject({
      eventId: "evt-session-subscription",
      eventType: "checkout.session.completed",
      orderId: null,
      subscription: null,
    });
    expect(
      provider.parseEvent({
        id: "evt-payment-invoice",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi-1", invoice: "in-1", metadata: {} } },
      }),
    ).toMatchObject({
      eventId: "evt-payment-invoice",
      eventType: "payment_intent.succeeded",
      orderId: null,
      subscription: null,
    });
  });

  it("keeps test webhook doubles outside the production provider registry", () => {
    const registry = new Map([["mock", new MockWebhookProvider()]]);
    const rawBody = Buffer.from(
      JSON.stringify({
        eventId: "mock-1",
        eventType: "payment_succeeded",
        data: { orderId: "checkout-1" },
      }),
    );
    const signature = createHmac("sha256", "secret")
      .update(rawBody)
      .digest("hex");
    expect(
      verifyProviderWebhook(
        registry,
        "mock",
        { "x-kokoro-webhook-signature": signature },
        rawBody,
        "secret",
      ),
    ).toBe(true);
    expect(
      parseProviderWebhook(registry, "mock", JSON.parse(rawBody.toString())),
    ).toMatchObject({ eventId: "mock-1", orderId: "checkout-1" });
  });

  it("accepts Alipay body-signature verification without a synthetic signature header", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const params = {
      notify_id: "notify-1",
      sign_type: "RSA2",
      app_id: "app-1",
      trade_status: "TRADE_SUCCESS",
      trade_no: "trade-1",
    };
    const signed = {
      ...params,
      sign: signAlipayNotification(
        params,
        privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      ),
    };
    const rawBody = Buffer.from(new URLSearchParams(signed).toString(), "utf8");
    const publicKeyPem = publicKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    const registry = createProviderRegistry(["alipay"]);
    expect(
      verifyProviderWebhook(registry, "alipay", {}, rawBody, publicKeyPem),
    ).toBe(true);
    expect(new AlipayWebhookProvider().parseEvent(signed)).toMatchObject({
      eventType: "payment_succeeded",
      externalPaymentRef: "trade-1",
    });
  });

  it("rejects a signed Alipay form that does not declare the canonical RSA2 algorithm", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const params = {
      notify_id: "notify-legacy",
      sign_type: "RSA",
      app_id: "app-1",
      trade_status: "TRADE_SUCCESS",
      trade_no: "trade-legacy",
    };
    const signed = {
      ...params,
      sign: signAlipayNotification(
        params,
        privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      ),
    };
    const rawBody = Buffer.from(new URLSearchParams(signed).toString(), "utf8");
    const publicKeyPem = publicKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    expect(
      verifyProviderWebhook(
        createProviderRegistry(["alipay"]),
        "alipay",
        {},
        rawBody,
        publicKeyPem,
      ),
    ).toBe(false);
  });

  it("decrypts WeChat APIv3 encrypted resources before normalizing the order reference", () => {
    const key = Buffer.from("01234567890123456789012345678901", "utf8");
    const nonce = randomBytes(12).toString("hex").slice(0, 12);
    const associatedData = "associated-data";
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(nonce, "utf8"),
    );
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ out_trade_no: "checkout-wechat-1" })),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
    const provider = new WechatWebhookProvider({
      apiV3Key: key.toString("utf8"),
    });
    expect(
      provider.parseEvent({
        id: "wx-event-1",
        event_type: "TRANSACTION.SUCCESS",
        resource: { ciphertext, nonce, associated_data: associatedData },
      }),
    ).toMatchObject({ orderId: "checkout-wechat-1" });
  });
});
