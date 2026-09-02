import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import type { ParsedWebhookEvent, PaymentWebhookProvider } from '../../provider-types.js';

const signatureHeader = 'x-kokoro-webhook-signature';
const eventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  data: z.object({ tenantId: z.string().min(1).optional(), orderId: z.string().min(1).optional() }).passthrough().optional(),
}).passthrough();

export class MockWebhookProvider implements PaymentWebhookProvider {
  public readonly kind = 'mock' as const;

  public verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
    const raw = headers[signatureHeader];
    const provided = Buffer.from(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '', 'utf8');
    const expectedBytes = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
    return provided.length === expectedBytes.length && timingSafeEqual(provided, expectedBytes);
  }

  public parseEvent(payload: unknown): ParsedWebhookEvent {
    const parsed = eventSchema.parse(payload);
    return { eventId: parsed.eventId, eventType: parsed.eventType, payloadTenantId: parsed.data?.tenantId ?? null, providerAccountRef: null, externalPaymentRef: parsed.eventType === 'payment_succeeded' ? parsed.eventId : null, externalReversalRef: parsed.eventType === 'refund_succeeded' ? parsed.eventId : null, refundAmountMinor: typeof parsed.data?.refundAmountMinor === 'number' ? parsed.data.refundAmountMinor : null, orderId: parsed.data?.orderId ?? null, subscription: null };
  }
}
