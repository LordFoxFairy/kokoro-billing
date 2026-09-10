import { describe, expect, it } from "vitest";
import { StripeWebhookProvider } from "../../src/infrastructure/providers/payment/adapters/stripe/stripe-webhook-provider.js";

const provider = new StripeWebhookProvider();
const eventTypes = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
];
const modes = [
  "payment",
  "subscription",
  "setup",
  undefined,
  null,
  "",
  false,
  1,
  {},
  [],
];
const statuses = [
  "paid",
  "unpaid",
  "no_payment_required",
  undefined,
  null,
  "",
  true,
  1,
  {},
  [],
];
const subscriptions = [undefined, null, "sub-1", "", false, 0, {}, []];
const emptyEffect = {
  orderId: null,
  externalPaymentRef: null,
  externalReversalRef: null,
  refundAmountMinor: null,
  subscription: null,
};
const envelope = (type: string, fields: Record<string, unknown>) => ({
  id: "evt-payment-gate",
  type,
  account: "acct-payment-gate",
  data: {
    object: {
      id: "cs-payment-gate",
      payment_intent: "pi-payment-gate",
      metadata: { checkoutId: "checkout-1", tenantId: "tenant-1" },
      ...fields,
    },
  },
});

describe.each(eventTypes)("Stripe paid-only %s", (type) => {
  it.each(
    modes.flatMap((mode) =>
      statuses.map((paymentStatus) => ({ mode, paymentStatus })),
    ),
  )(
    "gates mode=$mode paymentStatus=$paymentStatus",
    ({ mode, paymentStatus }) => {
      const result = provider.parseEvent(
        envelope(type, { mode, payment_status: paymentStatus }),
      );
      const paid = mode === "payment" && paymentStatus === "paid";
      expect(result).toEqual({
        eventId: "evt-payment-gate",
        eventType: paid ? "payment_succeeded" : type,
        providerAccountRef: "acct-payment-gate",
        payloadTenantId: "tenant-1",
        ...emptyEffect,
        ...(paid
          ? { orderId: "checkout-1", externalPaymentRef: "pi-payment-gate" }
          : {}),
      });
    },
  );

  it.each(subscriptions.map((subscription) => ({ subscription })))(
    "excludes any subscription reference $subscription",
    ({ subscription }) => {
      const result = provider.parseEvent(
        envelope(type, {
          mode: "payment",
          payment_status: "paid",
          subscription,
        }),
      );
      const oneTime = subscription === undefined || subscription === null;
      expect(result).toMatchObject(
        oneTime
          ? {
              eventType: "payment_succeeded",
              orderId: "checkout-1",
              externalPaymentRef: "pi-payment-gate",
            }
          : { eventType: type, ...emptyEffect },
      );
    },
  );

  it("ignores an absent Checkout object", () => {
    expect(
      provider.parseEvent({ id: "evt-empty", type, data: {} }),
    ).toMatchObject({ eventType: type, ...emptyEffect });
  });
});

describe("other Stripe branches remain independent of Checkout paid-only gating", () => {
  it("preserves charge refund facts without Checkout mode/status", () => {
    expect(
      provider.parseEvent(
        envelope("charge.refunded", {
          refunds: { data: [{ id: "re-1", amount: 200 }] },
        }),
      ),
    ).toMatchObject({
      eventType: "refund_succeeded",
      orderId: "checkout-1",
      externalReversalRef: "re-1",
      refundAmountMinor: 200,
    });
  });
  it("preserves the existing subscription normalization branch", () => {
    expect(
      provider.parseEvent(
        envelope("customer.subscription.updated", {
          status: "active",
          current_period_start: 1700000000,
          current_period_end: 1700100000,
          metadata: {
            tenantId: "tenant-1",
            teamId: "subject-1",
            planId: "plan-1",
          },
        }),
      ),
    ).toMatchObject({
      eventType: "subscription_updated",
      subscription: { grantCredits: true },
    });
  });
  it("does not loosen non-Checkout subscription field validation", () => {
    expect(() =>
      provider.parseEvent(
        envelope("customer.subscription.updated", { subscription: {} }),
      ),
    ).toThrow("stripe webhook payload is invalid");
  });
});
