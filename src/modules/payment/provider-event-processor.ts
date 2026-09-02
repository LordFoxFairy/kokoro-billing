import { createHash, randomUUID } from 'node:crypto';
import type { Connection, RowDataPacket } from '../../../src/infrastructure/postgres/connection.js';
import { readSafeInteger } from '../../infrastructure/postgres/safe-integer.js';
import { parseProviderWebhook } from './provider-registry.js';
import type { ProviderRegistry } from './provider-registry.js';
import { PAYMENT_WEBHOOK_EVENT } from './provider-types.js';
import type { BillingSettlementService } from './billing-settlement-service.js';
import type { BillingReversalService } from './billing-reversal-service.js';
import type { SubscriptionGrantService } from '../credit/subscription-grant-service.js';
import type { ParsedSubscriptionEvent } from './provider-types.js';

type EventRow = RowDataPacket & {
  provider_event_id: string;
  tenant_id: string;
  provider: string;
  provider_account_ref: string | null;
  processing_status: 'received' | 'processed' | 'ignored' | 'failed';
  payload_json: string | Record<string, unknown>;
};
type CheckoutRow = RowDataPacket & {
  checkout_id: string;
  subject_id: string;
  amount_minor: number | string;
  currency: string;
  quote_snapshot_json: string | Record<string, unknown>;
  provider_account_ref: string | null;
};
type GrantRow = RowDataPacket & { credit_account_id: string; original_micros: number | string };

const uuidFromKey = (key: string): string => {
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const object = (value: string | Record<string, unknown>): Record<string, unknown> => typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value;

const snapshot = (value: string | Record<string, unknown>): { programKey: string; creditMicros: number } => {
  const data = object(value);
  if (typeof data.key !== 'string' || !/^\d+$/u.test(String(data.creditMicros ?? ''))) throw new Error('billing.checkout_quote_invalid');
  return { programKey: data.key, creditMicros: readSafeInteger(String(data.creditMicros), 'credit_micros') };
};

/** Worker-side payment event dispatcher. HTTP only writes inbox/outbox. */
export class ProviderEventProcessor {
  public constructor(
    private readonly connection: Connection,
    private readonly providers: ProviderRegistry,
    private readonly settlement: Pick<BillingSettlementService, 'recordSettlement' | 'fulfillSettlement'>,
    private readonly reversal: Pick<BillingReversalService, 'recordReversal' | 'reverseCredits'>,
    private readonly subscriptionGrant: Pick<SubscriptionGrantService, 'grant'>,
  ) {}

  public async process(providerEventId: string): Promise<void> {
    const event = await this.getEvent(providerEventId);
    if (!event || event.processing_status === 'processed' || event.processing_status === 'ignored') return;
    await this.connection.execute(`UPDATE payment_provider_event SET processing_attempts = processing_attempts + 1 WHERE tenant_id = $1 AND provider_event_id = $2`, [event.tenant_id, providerEventId]);
    try {
      const parsed = parseProviderWebhook(this.providers, event.provider, object(event.payload_json));
      if (parsed.eventType === PAYMENT_WEBHOOK_EVENT.paymentSucceeded) {
        await this.processPayment(event, parsed.orderId, parsed.eventId, parsed.externalPaymentRef);
        await this.markProcessed(event.tenant_id, providerEventId);
      } else if (parsed.eventType === PAYMENT_WEBHOOK_EVENT.refundSucceeded) {
        await this.processRefund(event, parsed.orderId, parsed.eventId, parsed.externalReversalRef, parsed.refundAmountMinor);
        await this.markProcessed(event.tenant_id, providerEventId);
      } else if (parsed.eventType === PAYMENT_WEBHOOK_EVENT.subscriptionUpdated) {
        if (!parsed.subscription) throw new Error('billing.subscription_event_invalid');
        await this.processSubscription(event, parsed.subscription);
        await this.markProcessed(event.tenant_id, providerEventId);
      } else {
        await this.markIgnored(event.tenant_id, providerEventId);
      }
    } catch (error) {
      await this.markFailed(event.tenant_id, providerEventId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async processPayment(event: EventRow, checkoutId: string | null, externalEventId: string, externalPaymentRef: string | null): Promise<void> {
    if (!checkoutId) throw new Error('billing.payment_event_missing_checkout');
    const checkout = await this.getCheckout(event.tenant_id, checkoutId);
    this.assertProviderAccount(checkout.provider_account_ref, event.provider_account_ref);
    const plan = snapshot(checkout.quote_snapshot_json);
    const settlementId = uuidFromKey(`payment-settlement:${event.tenant_id}:${event.provider}:${externalEventId}`);
    await this.settlement.recordSettlement({
      settlementId, tenantId: event.tenant_id, provider: event.provider, providerEventId: event.provider_event_id, checkoutId: checkout.checkout_id,
      externalPaymentRef: externalPaymentRef ?? `${event.provider}:${externalEventId}`,
      amountMinor: readSafeInteger(checkout.amount_minor, 'checkout_amount_minor'), currency: checkout.currency,
    });
    const accountId = await this.accountId(event.tenant_id, checkout.subject_id);
    if (plan.creditMicros > 0) await this.settlement.fulfillSettlement({ settlementId, tenantId: event.tenant_id, accountId, subjectId: checkout.subject_id, programKey: plan.programKey, grantMicros: plan.creditMicros });
  }

  private async processRefund(event: EventRow, checkoutId: string | null, externalEventId: string, externalReversalRef: string | null, refundAmountMinor: number | null): Promise<void> {
    if (!checkoutId) throw new Error('billing.refund_event_missing_checkout');
    const checkout = await this.getCheckout(event.tenant_id, checkoutId);
    this.assertProviderAccount(checkout.provider_account_ref, event.provider_account_ref);
    const plan = snapshot(checkout.quote_snapshot_json);
    const [settlements] = await this.connection.execute<(RowDataPacket & { settlement_id: string; amount_minor: number | string })[]>(`SELECT settlement_id, amount_minor FROM payment_settlement WHERE tenant_id = $1 AND provider = $2 AND checkout_id = $3 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [event.tenant_id, event.provider, checkout.checkout_id]);
    const settlement = settlements[0];
    if (!settlement) throw new Error('billing.settlement_not_found');
    const [grants] = await this.connection.execute<GrantRow[]>(`SELECT g.credit_account_id, g.original_micros FROM entitlement_credit_grant g JOIN entitlement_acquisition a ON a.tenant_id = g.tenant_id AND a.source_kind = 'payment_settlement' AND a.source_ref = g.source_ref WHERE g.tenant_id = $1 AND g.source_ref = $2 LIMIT 1`, [event.tenant_id, settlement.settlement_id]);
    const grant = grants[0];
    if (!grant && plan.creditMicros > 0) throw new Error('billing.refund_grant_not_found');
    if (!grant) return;
    const amountMinor = refundAmountMinor ?? readSafeInteger(settlement.amount_minor, 'settlement_amount_minor');
    const reversalId = await this.reversal.recordReversal({ provider: event.provider, tenantId: event.tenant_id, settlementId: settlement.settlement_id, externalReversalRef: externalReversalRef ?? `${event.provider}:${externalEventId}`, amountMinor, reason: 'provider_refund', idempotencyKey: `provider-refund:${event.provider}:${externalEventId}` });
    // Leave the credit amount allocation to the locked reversal transaction so concurrent partial refunds cannot over-reverse.
    await this.reversal.reverseCredits({ tenantId: event.tenant_id, reversalId, settlementId: settlement.settlement_id, accountId: grant.credit_account_id });
  }

  private async processSubscription(event: EventRow, subscription: ParsedSubscriptionEvent): Promise<void> {
    if (subscription.status === 'canceled' && (!subscription.currentPeriodStart || !subscription.currentPeriodEnd)) {
      await this.connection.execute(
        `UPDATE payment_provider_subscription SET status = 'canceled'
          WHERE tenant_id = $1 AND provider = $2 AND external_subscription_ref = $3`,
        [event.tenant_id, event.provider, subscription.providerSubscriptionId],
      );
      return;
    }
    if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
      if (subscription.status === 'active' && subscription.grantCredits) throw new Error('billing.subscription_period_missing');
    }
    const [revisions] = await this.connection.execute<(RowDataPacket & { offer_key: string; credit_micros: number | string })[]>(
      `SELECT o.offer_key, r.credit_micros
         FROM entitlement_offer_revision r JOIN entitlement_offer o ON o.offer_id = r.offer_id
        WHERE r.tenant_id = $1 AND r.status = 'published' AND (r.offer_revision_id = $2 OR o.offer_key = $3)
        ORDER BY r.revision DESC LIMIT 1`,
      [event.tenant_id, subscription.planId, subscription.planId],
    );
    const revision = revisions[0];
    if (!revision) throw new Error('billing.subscription_offer_not_found');
    const providerAccountId = await this.resolveProviderAccountId(event);
    const providerSubscriptionId = uuidFromKey(`provider-subscription:${event.tenant_id}:${event.provider}:${subscription.providerSubscriptionId}`);
    const [existingSubscriptions] = await this.connection.execute<(RowDataPacket & { provider_account_id: string | null })[]>(
      `SELECT provider_account_id FROM payment_provider_subscription
        WHERE tenant_id = $1 AND provider = $2 AND external_subscription_ref = $3 FOR UPDATE`,
      [event.tenant_id, event.provider, subscription.providerSubscriptionId],
    );
    const existingProviderAccountId = existingSubscriptions[0]?.provider_account_id ?? null;
    if (existingProviderAccountId !== null && existingProviderAccountId !== providerAccountId) throw new Error('billing.provider_account_mismatch');
    await this.connection.execute(
      `INSERT INTO payment_provider_subscription
        (provider_subscription_id, tenant_id, provider, subject_id, provider_account_id, external_subscription_ref, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, provider, external_subscription_ref) DO UPDATE SET subject_id = EXCLUDED.subject_id, provider_account_id = COALESCE(EXCLUDED.provider_account_id, payment_provider_subscription.provider_account_id), status = EXCLUDED.status`,
      [providerSubscriptionId, event.tenant_id, event.provider, subscription.teamId, providerAccountId, subscription.providerSubscriptionId, subscription.status],
    );
    if (providerAccountId !== null) {
      await this.connection.execute(
        `UPDATE payment_provider_subscription SET provider_account_id = $1
          WHERE tenant_id = $2 AND provider_subscription_id = $3 AND (provider_account_id IS NULL OR provider_account_id = $4)`,
        [providerAccountId, event.tenant_id, providerSubscriptionId, providerAccountId],
      );
    }
    if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) return;
    const periodKey = `${subscription.providerSubscriptionId}:${subscription.currentPeriodStart.toISOString()}:${subscription.currentPeriodEnd.toISOString()}`;
    const periodId = uuidFromKey(`subscription-period:${event.tenant_id}:${event.provider}:${periodKey}`);
    await this.connection.execute(
      `INSERT INTO payment_subscription_period
        (period_id, tenant_id, provider_subscription_id, period_start, period_end, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider_subscription_id, period_start, period_end) DO UPDATE SET status = EXCLUDED.status`,
      [periodId, event.tenant_id, providerSubscriptionId, subscription.currentPeriodStart, subscription.currentPeriodEnd, subscription.status === 'active' ? 'open' : 'unknown'],
    );
    const amountMicros = readSafeInteger(revision.credit_micros, 'subscription_credit_micros');
    await this.connection.execute(
      `INSERT INTO entitlement_subscription_term
        (term_id, tenant_id, subject_id, source_period_id, program_key, period_start, period_end, status, grant_micros)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, source_period_id) DO UPDATE SET status = EXCLUDED.status, grant_micros = EXCLUDED.grant_micros`,
      [periodId, event.tenant_id, subscription.teamId, periodId, revision.offer_key, subscription.currentPeriodStart, subscription.currentPeriodEnd, subscription.status, amountMicros],
    );
    if (subscription.grantCredits) {
      if (amountMicros > 0) {
        const accountId = await this.accountId(event.tenant_id, subscription.teamId);
        await this.subscriptionGrant.grant({ tenantId: event.tenant_id, subjectId: subscription.teamId, accountId, periodId, programKey: revision.offer_key, amountMicros, expiresAt: subscription.currentPeriodEnd });
      }
    }
  }

  private assertProviderAccount(checkoutAccountRef: string | null, eventAccountRef: string | null): void { if ((checkoutAccountRef !== null || eventAccountRef !== null) && checkoutAccountRef !== eventAccountRef) throw new Error('billing.provider_account_mismatch'); }
  private async resolveProviderAccountId(event: EventRow): Promise<string | null> {
    if (event.provider_account_ref === null) return null;
    const [rows] = await this.connection.execute<(RowDataPacket & { provider_account_id: string })[]>(
      `SELECT provider_account_id FROM payment_provider_account
        WHERE tenant_id = $1 AND provider = $2 AND external_account_ref = $3 AND status = 'active'`,
      [event.tenant_id, event.provider, event.provider_account_ref],
    );
    if (!rows[0]) throw new Error('billing.provider_account_not_found');
    return rows[0].provider_account_id;
  }
  private async getEvent(id: string): Promise<EventRow | undefined> { const [rows] = await this.connection.execute<EventRow[]>(`SELECT provider_event_id, tenant_id, provider, provider_account_ref, processing_status, payload_json FROM payment_provider_event WHERE provider_event_id = $1`, [id]); return rows[0]; }
  private async getCheckout(tenantId: string, checkoutId: string): Promise<CheckoutRow> { const [rows] = await this.connection.execute<CheckoutRow[]>(`SELECT checkout_id, subject_id, amount_minor, currency, provider_account_ref, quote_snapshot_json FROM payment_checkout WHERE tenant_id = $1 AND checkout_id = $2`, [tenantId, checkoutId]); if (!rows[0]) throw new Error('billing.checkout_not_found'); return rows[0]; }
  private async accountId(tenantId: string, subjectId: string): Promise<string> {
    const accountId = randomUUID();
    await this.connection.execute(`INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [accountId, tenantId, subjectId]);
    const [rows] = await this.connection.execute<(RowDataPacket & { credit_account_id: string })[]>(`SELECT credit_account_id FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, subjectId]);
    if (!rows[0]) throw new Error('billing.credit_account_not_found');
    return rows[0].credit_account_id;
  }
  private async markProcessed(tenantId: string, id: string): Promise<void> { await this.connection.execute(`UPDATE payment_provider_event SET processing_status = 'processed', processed_at = CURRENT_TIMESTAMP(6), last_error = NULL WHERE tenant_id = $1 AND provider_event_id = $2`, [tenantId, id]); }
  private async markIgnored(tenantId: string, id: string): Promise<void> { await this.connection.execute(`UPDATE payment_provider_event SET processing_status = 'ignored', processed_at = CURRENT_TIMESTAMP(6), last_error = NULL WHERE tenant_id = $1 AND provider_event_id = $2`, [tenantId, id]); }
  private async markFailed(tenantId: string, id: string, error: string): Promise<void> { await this.connection.execute(`UPDATE payment_provider_event SET processing_status = 'failed', last_error = $1 WHERE tenant_id = $2 AND provider_event_id = $3`, [error.slice(0, 1024), tenantId, id]); }
}
