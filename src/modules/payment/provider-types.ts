import type { IncomingHttpHeaders } from 'node:http';

export const PAYMENT_WEBHOOK_EVENT = {
  paymentSucceeded: 'payment_succeeded',
  refundSucceeded: 'refund_succeeded',
  subscriptionUpdated: 'subscription_updated',
} as const;

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled';
export type ParsedSubscriptionEvent = {
  readonly providerSubscriptionId: string;
  readonly teamId: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly grantCredits: boolean;
};
export type ParsedWebhookEvent = {
  readonly eventId: string;
  readonly eventType: string;
  /** Canonical provider metadata is tenantId; neither payload field is allowed to select the tenant. */
  readonly payloadTenantId: string | null;
  readonly providerAccountRef: string | null;
  readonly externalPaymentRef: string | null;
  readonly externalReversalRef: string | null;
  /** Provider refund amount in the settlement currency's minor unit. Null means full settlement refund. */
  readonly refundAmountMinor: number | null;
  readonly orderId: string | null;
  readonly subscription: ParsedSubscriptionEvent | null;
};
export interface PaymentWebhookProvider {
  readonly kind: 'stripe' | 'alipay' | 'wechat' | 'mock';
  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean;
  decodeBody?(rawBody: Buffer): unknown;
  parseEvent(payload: unknown): ParsedWebhookEvent;
}
export class WebhookError extends Error {
  public constructor(public readonly code: string, message: string, public readonly statusCode: number) { super(message); this.name = 'WebhookError'; }
}
