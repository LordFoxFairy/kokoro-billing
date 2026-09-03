import { z } from 'zod';
import { type ParsedSubscriptionEvent, type SubscriptionStatus } from '../../../../application/payment/ports/provider-types.js';

export const webhookMetadataSchema = z.object({ tenantId: z.string().min(1).optional(), orderId: z.string().min(1).optional(), checkoutId: z.string().min(1).optional(), teamId: z.string().min(1).optional(), planId: z.string().min(1).optional() }).passthrough();

export const providerPayloadTenantId = (metadata: z.infer<typeof webhookMetadataSchema>): string | null => {
  return metadata.tenantId ?? null;
};
export function unixSecondsToDate(value: unknown): Date | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}
export function minorAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}
export function buildSubscriptionEvent(input: { metadata: z.infer<typeof webhookMetadataSchema>; providerSubscriptionId: string; status: SubscriptionStatus; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; grantCredits: boolean }): ParsedSubscriptionEvent | null {
  if (!input.metadata.teamId || !input.metadata.planId) return null;
  return { providerSubscriptionId: input.providerSubscriptionId, teamId: input.metadata.teamId, planId: input.metadata.planId, status: input.status, currentPeriodStart: input.currentPeriodStart, currentPeriodEnd: input.currentPeriodEnd, grantCredits: input.grantCredits };
}
