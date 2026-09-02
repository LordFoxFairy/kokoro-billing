import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import Stripe from "stripe";
import { z } from "zod";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../../provider-types.js";
import { PAYMENT_WEBHOOK_EVENT, WebhookError } from "../../provider-types.js";
import {
  buildSubscriptionEvent,
  providerPayloadTenantId,
  unixSecondsToDate,
  webhookMetadataSchema,
  minorAmount,
} from "../normalize.js";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
// Stripe 默认容差 5 分钟（防重放）。
const DEFAULT_TOLERANCE_SECONDS = 300;

// Stripe webhook 事件信封：只取归一化所需字段，其余 passthrough。
const stripeEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    account: z.string().optional(),
    data: z
      .object({
        object: z
          .object({
            id: z.string().optional(),
            status: z.string().optional(),
            current_period_start: z.union([z.number(), z.string()]).optional(),
            current_period_end: z.union([z.number(), z.string()]).optional(),
            subscription: z.string().nullable().optional(),
            invoice: z.string().nullable().optional(),
            metadata: webhookMetadataSchema.optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Stripe subscription.status → 内部订阅态。active/trialing 发放本周期积分。
function mapSubscriptionStatus(raw: string | undefined): {
  status: "active" | "past_due" | "canceled";
  grantCredits: boolean;
} {
  if (raw === "active" || raw === "trialing") {
    return { status: "active", grantCredits: true };
  }
  if (raw === "canceled" || raw === "incomplete_expired") {
    return { status: "canceled", grantCredits: false };
  }
  return { status: "past_due", grantCredits: false };
}

function stripeRefundFacts(value: Record<string, unknown> | undefined): { externalReversalRef: string; refundAmountMinor: number | null } {
  const refunds = value?.refunds;
  const data = refunds && typeof refunds === 'object' && Array.isArray((refunds as { data?: unknown[] }).data)
    ? (refunds as { data: unknown[] }).data
    : [];
  const latest = data[0] && typeof data[0] === 'object' ? data[0] as Record<string, unknown> : undefined;
  return {
    externalReversalRef: typeof latest?.id === 'string' ? latest.id : typeof value?.id === 'string' ? value.id : 'stripe-refund-unknown',
    // charge.amount_refunded is cumulative; prefer the latest Refund.amount so
    // multiple partial refunds become independent reversal facts.
    refundAmountMinor: minorAmount(latest?.amount) ?? minorAmount(value?.amount_refunded ?? value?.amount),
  };
}

// 测试向量构造：Stripe `t=<ts>,v1=<hmac>` 头。签名覆盖 `${t}.${rawBody}`。
export function signStripeWebhook(rawBody: Buffer | string, secret: string, timestamp: number): string {
  const payload = `${timestamp}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

interface StripeProviderOptions {
  toleranceSeconds?: number;
  now?: () => number; // epoch 秒；测试可注入以固定容差判定。
}

// Stripe webhook 验签：HMAC-SHA256(secret, `${t}.${rawBody}`)，容差窗口内比对任一 v1。
export class StripeWebhookProvider implements PaymentWebhookProvider {
  readonly kind = "stripe" as const;
  private readonly toleranceSeconds: number;
  private readonly now: () => number;
  private readonly webhooks: Stripe.Webhooks;

  constructor(options: StripeProviderOptions = {}) {
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.webhooks = new Stripe("sk_test_placeholder").webhooks;
  }

  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
    const raw = headers[STRIPE_SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) {
      return false;
    }
    try {
      this.webhooks.constructEvent(rawBody, header, secret, this.toleranceSeconds, undefined, this.now() * 1000);
      return true;
    } catch {
      return false;
    }
  }

  parseEvent(payload: unknown): ParsedWebhookEvent {
    const parsed = stripeEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new WebhookError(
        "payment.webhook_payload_invalid",
        "stripe webhook payload is invalid: expected { id, type, data }",
        400,
      );
    }
    const { id, type } = parsed.data;
    const providerAccountRef = parsed.data.account ?? null;
    const object = parsed.data.data?.object;
    const metadata = webhookMetadataSchema.parse(object?.metadata ?? {});

    // Subscription Checkout is fulfilled by customer.subscription.* events. The
    // session/payment-intent callbacks must not be mistaken for one-time credit grants.
    if ((type === "checkout.session.completed" && object?.subscription) || (type === "payment_intent.succeeded" && object?.invoice)) {
      return { eventId: id, eventType: type, payloadTenantId: providerPayloadTenantId(metadata), providerAccountRef, externalPaymentRef: null, externalReversalRef: null, refundAmountMinor: null, orderId: null, subscription: null };
    }

    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      return { eventId: id, eventType: PAYMENT_WEBHOOK_EVENT.paymentSucceeded, payloadTenantId: providerPayloadTenantId(metadata), providerAccountRef, externalPaymentRef: typeof object?.payment_intent === 'string' ? object.payment_intent : object?.id ?? id, externalReversalRef: null, refundAmountMinor: null, orderId: metadata.orderId ?? metadata.checkoutId ?? null, subscription: null };
    }
    if (type === "payment_intent.succeeded") {
      // Checkout Session completion is the canonical acquisition event. The
      // PaymentIntent callback is an acknowledgement and must not create a
      // second settlement for the same checkout.
      return { eventId: id, eventType: type, payloadTenantId: providerPayloadTenantId(metadata), providerAccountRef, externalPaymentRef: null, externalReversalRef: null, refundAmountMinor: null, orderId: null, subscription: null };
    }
    if (type === "charge.refunded") {
      const refund = stripeRefundFacts(object);
      return { eventId: id, eventType: PAYMENT_WEBHOOK_EVENT.refundSucceeded, payloadTenantId: providerPayloadTenantId(metadata), providerAccountRef, externalPaymentRef: null, externalReversalRef: refund.externalReversalRef, refundAmountMinor: refund.refundAmountMinor, orderId: metadata.orderId ?? metadata.checkoutId ?? null, subscription: null };
    }
    if (type.startsWith("customer.subscription.")) {
      const { status, grantCredits } =
        type === "customer.subscription.deleted"
          ? { status: "canceled" as const, grantCredits: false }
          : mapSubscriptionStatus(object?.status);
      const subscription = buildSubscriptionEvent({
        metadata,
        providerSubscriptionId: object?.id ?? id,
        status,
        currentPeriodStart: unixSecondsToDate(object?.current_period_start),
        currentPeriodEnd: unixSecondsToDate(object?.current_period_end),
        grantCredits,
      });
      return { eventId: id, eventType: PAYMENT_WEBHOOK_EVENT.subscriptionUpdated, payloadTenantId: providerPayloadTenantId(metadata), providerAccountRef, externalPaymentRef: null, externalReversalRef: null, refundAmountMinor: null, orderId: null, subscription };
    }
    // 未订阅的事件类型：ack（eventType 保持原样，process 走默认分支不产生副作用）。
    return { eventId: id, eventType: type, payloadTenantId: providerPayloadTenantId(metadata), providerAccountRef, externalPaymentRef: null, externalReversalRef: null, refundAmountMinor: null, orderId: null, subscription: null };
  }
}
