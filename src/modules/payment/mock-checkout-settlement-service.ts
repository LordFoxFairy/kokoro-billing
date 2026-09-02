import { randomUUID } from 'node:crypto';
import type { Connection, RowDataPacket } from '../../application/ports.js';
import type { BillingSettlementService, FulfillmentResult } from './billing-settlement-service.js';
import { z } from 'zod';

type CheckoutRow = RowDataPacket & {
  checkout_id: string;
  subject_id: string;
  offer_revision_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  quote_snapshot_json: string | Record<string, unknown>;
};
type AccountRow = RowDataPacket & { credit_account_id: string };
type SettlementRow = RowDataPacket & { settlement_id: string };

const quoteSnapshotSchema = z.object({ key: z.string().min(1), creditMicros: z.string().regex(/^\d+$/u) });

export type ProcessMockPaymentInput = {
  readonly tenantId: string;
  readonly providerEventId: string;
  readonly externalEventId: string;
  readonly checkoutId: string;
};

/**
 * Local-only provider processor. It deliberately reuses the normal settlement
 * and fulfillment application service; mock payment must not have a second
 * credit-grant implementation.
 */
export class MockCheckoutSettlementService {
  public constructor(private readonly connection: Connection, private readonly settlement: Pick<BillingSettlementService, 'recordSettlement' | 'fulfillSettlement'>) {}

  public async process(input: ProcessMockPaymentInput): Promise<FulfillmentResult | null> {
    const [checkouts] = await this.connection.execute<CheckoutRow[]>(
      `SELECT checkout_id, subject_id, offer_revision_id, amount_minor, currency, status, quote_snapshot_json
         FROM payment_checkout WHERE checkout_id = $1 AND tenant_id = $2`,
      [input.checkoutId, input.tenantId],
    );
    const checkout = checkouts[0];
    if (!checkout) throw new Error('billing.checkout_not_found');

    const snapshotRaw = typeof checkout.quote_snapshot_json === 'string'
      ? JSON.parse(checkout.quote_snapshot_json) as unknown
      : checkout.quote_snapshot_json;
    const snapshot = quoteSnapshotSchema.safeParse(snapshotRaw);
    if (!snapshot.success) throw new Error('billing.checkout_quote_invalid');

    const externalPaymentRef = `mock:${input.externalEventId}`;
    const [existing] = await this.connection.execute<SettlementRow[]>(
      `SELECT settlement_id FROM payment_settlement WHERE tenant_id = $1 AND provider = 'mock' AND external_payment_ref = $2`,
      [input.tenantId, externalPaymentRef],
    );
    const settlementId = existing[0]?.settlement_id ?? randomUUID();
    await this.connection.execute(
      `INSERT INTO payment_settlement
        (settlement_id, tenant_id, provider_event_id, checkout_id, provider, external_payment_ref, amount_minor, currency, status)
       VALUES ($1, $2, $3, $4, 'mock', $5, $6, $7, 'succeeded')
       ON CONFLICT DO NOTHING`,
      [settlementId, input.tenantId, input.providerEventId, checkout.checkout_id, externalPaymentRef, checkout.amount_minor, checkout.currency],
    );
    await this.connection.execute(
      `UPDATE payment_checkout SET status = 'paid' WHERE checkout_id = $1 AND tenant_id = $2 AND status IN ('created', 'pending_payment')`,
      [checkout.checkout_id, input.tenantId],
    );

    const [accounts] = await this.connection.execute<AccountRow[]>(
      `SELECT credit_account_id FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2`,
      [input.tenantId, checkout.subject_id],
    );
    const accountId = accounts[0]?.credit_account_id ?? randomUUID();
    await this.connection.execute(
      `INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [accountId, input.tenantId, checkout.subject_id],
    );

    if (Number(snapshot.data.creditMicros) <= 0) {
      await this.connection.execute(
        `UPDATE payment_provider_event SET processing_status = 'processed', processed_at = CURRENT_TIMESTAMP(6)
          WHERE tenant_id = $1 AND provider_event_id = $2`,
        [input.tenantId, input.providerEventId],
      );
      return null;
    }
    const result = await this.settlement.fulfillSettlement({
      settlementId,
      tenantId: input.tenantId,
      accountId,
      subjectId: checkout.subject_id,
      programKey: snapshot.data.key,
      grantMicros: Number(snapshot.data.creditMicros),
    });
    await this.connection.execute(
      `UPDATE payment_provider_event SET processing_status = 'processed', processed_at = CURRENT_TIMESTAMP(6)
        WHERE tenant_id = $1 AND provider_event_id = $2`,
      [input.tenantId, input.providerEventId],
    );
    return result;
  }
}
