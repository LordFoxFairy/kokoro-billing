import { createHash, randomUUID } from 'node:crypto';
import type { Connection, RowDataPacket } from '../../application/ports.js';
import { readSafeInteger } from '../../infrastructure/postgres/safe-integer.js';
import { z } from 'zod';
import type { HostedCheckoutProvider } from './hosted-checkout-provider.js';

export type CreateCheckoutInput = {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly idempotencyKey: string;
  readonly offerRevisionId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly quoteSnapshot: unknown;
  readonly expiresAt: Date;
};

export type Checkout = {
  readonly checkoutId: string;
  readonly status: 'created' | 'pending_payment' | 'paid' | 'expired' | 'cancelled';
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAt: Date;
  readonly checkoutUrl?: string;
};

type CheckoutRow = RowDataPacket & { checkout_id: string; tenant_id: string; quote_hash: string; amount_minor: number; currency: string; expires_at: Date; status: 'created'; provider_account_ref: string | null };
type OfferRevisionRow = RowDataPacket & { offer_key: string; amount_minor: number | string; currency: string; credit_micros: number | string; billing_interval: 'once' | 'month' | 'year' };
const quoteSnapshotSchema = z.object({ key: z.string().min(1), creditMicros: z.string().regex(/^\d+$/u) }).passthrough();

const hashQuote = (input: CreateCheckoutInput): string => createHash('sha256').update(JSON.stringify({
  subjectId: input.subjectId,
  offerRevisionId: input.offerRevisionId,
  amountMinor: input.amountMinor,
  currency: input.currency,
  quoteSnapshot: input.quoteSnapshot,
})).digest('hex');

export class CheckoutService {
  public constructor(private readonly connection: Connection, private readonly options: { readonly mockEnabled?: boolean; readonly hostedProvider?: HostedCheckoutProvider; readonly publicBaseUrl?: string } = {}) {}

  public async create(input: CreateCheckoutInput): Promise<Checkout> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RangeError('amountMinor must be positive');
    if (input.expiresAt.getTime() <= Date.now()) throw new Error('billing.quote_expired');
    if (this.options.mockEnabled === false) throw new Error('billing.checkout_provider_unavailable');
    const quote = quoteSnapshotSchema.safeParse(input.quoteSnapshot);
    if (!quote.success) throw new Error('billing.checkout_quote_invalid');
    const [revisions] = await this.connection.execute<OfferRevisionRow[]>(
      `SELECT o.offer_key, r.amount_minor, r.currency, r.credit_micros
         FROM entitlement_offer_revision r
         JOIN entitlement_offer o ON o.offer_id = r.offer_id AND o.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.offer_revision_id = $2 AND o.status = 'active'
          AND r.status = 'published' AND r.deleted_at IS NULL AND r.published_at IS NOT NULL`,
      [input.tenantId, input.offerRevisionId],
    );
    const revision = revisions[0];
    if (!revision) throw new Error('billing.offer_revision_not_sellable');
    if (readSafeInteger(revision.amount_minor, 'offer_amount_minor') !== input.amountMinor || revision.currency !== input.currency || revision.offer_key !== quote.data.key || String(revision.credit_micros) !== quote.data.creditMicros) {
      throw new Error('billing.checkout_quote_mismatch');
    }
    const quoteHash = hashQuote(input);
    const checkoutId = randomUUID();
    await this.connection.execute(
      `INSERT INTO payment_checkout
        (checkout_id, tenant_id, subject_id, idempotency_key, offer_revision_id, quote_hash,
         quote_snapshot_json, amount_minor, currency, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'created', $10)
       ON CONFLICT DO NOTHING`,
      [checkoutId, input.tenantId, input.subjectId, input.idempotencyKey, input.offerRevisionId, quoteHash, JSON.stringify(input.quoteSnapshot), input.amountMinor, input.currency, input.expiresAt],
    );
    const [rows] = await this.connection.execute<CheckoutRow[]>(
      `SELECT checkout_id, quote_hash, amount_minor, currency, expires_at, status
         FROM payment_checkout WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new Error('billing.checkout_not_found');
    if (row.quote_hash !== quoteHash) throw new Error('billing.idempotency_conflict');
    return { checkoutId: row.checkout_id, status: row.status, amountMinor: readSafeInteger(row.amount_minor, 'checkout_amount_minor'), currency: row.currency, expiresAt: new Date(row.expires_at) };
  }

  public async createHostedSession(tenantId: string, checkoutId: string): Promise<Checkout> {
    const [rows] = await this.connection.execute<(CheckoutRow & { subject_id: string; offer_revision_id: string; quote_snapshot_json: string | Record<string, unknown>; provider: string | null; checkout_url: string | null; billing_interval: 'once' | 'month' | 'year' })[]>(
      `SELECT c.checkout_id, c.tenant_id, c.subject_id, c.offer_revision_id, c.quote_snapshot_json, c.quote_hash, c.amount_minor, c.currency, c.expires_at, c.status, c.provider, c.provider_account_ref, c.checkout_url, r.billing_interval
         FROM payment_checkout c INNER JOIN entitlement_offer_revision r ON r.offer_revision_id = c.offer_revision_id AND r.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.checkout_id = $2 FOR UPDATE`,
      [tenantId, checkoutId],
    );
    const row = rows[0];
    if (!row) throw new Error('billing.checkout_not_found');
    if (row.checkout_url) return { checkoutId: row.checkout_id, status: row.status, amountMinor: readSafeInteger(row.amount_minor, 'checkout_amount_minor'), currency: row.currency, expiresAt: new Date(row.expires_at), checkoutUrl: row.checkout_url };
    if (this.options.mockEnabled) return { checkoutId: row.checkout_id, status: row.status, amountMinor: readSafeInteger(row.amount_minor, 'checkout_amount_minor'), currency: row.currency, expiresAt: new Date(row.expires_at) };
    const provider = this.options.hostedProvider;
    if (!provider || !this.options.publicBaseUrl) throw new Error('billing.checkout_provider_unavailable');
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error('billing.quote_expired');
    const quote = quoteSnapshotSchema.parse(typeof row.quote_snapshot_json === 'string' ? JSON.parse(row.quote_snapshot_json) : row.quote_snapshot_json);
    const checkoutPage = `${this.options.publicBaseUrl.replace(/\/$/u, '')}/billing/pay/${row.checkout_id}`;
    const session = await provider.createSession({ checkoutId: row.checkout_id, tenantId: row.tenant_id, subjectId: row.subject_id, amountMinor: readSafeInteger(row.amount_minor, 'checkout_amount_minor'), currency: row.currency, billingInterval: row.billing_interval, productName: typeof quote.name === 'string' ? quote.name : quote.key, successUrl: `${checkoutPage}?payment=success`, cancelUrl: `${checkoutPage}?payment=cancelled` });
    await this.connection.execute(`UPDATE payment_checkout SET provider = $1, provider_account_ref = $2, provider_session_id = $3, checkout_url = $4, status = 'pending_payment' WHERE tenant_id = $5 AND checkout_id = $6 AND checkout_url IS NULL`, [session.provider, session.providerAccountRef ?? provider.providerAccountRef ?? null, session.sessionId, session.checkoutUrl, row.tenant_id, checkoutId]);
    return { checkoutId: row.checkout_id, status: 'pending_payment', amountMinor: readSafeInteger(row.amount_minor, 'checkout_amount_minor'), currency: row.currency, expiresAt: new Date(row.expires_at), checkoutUrl: session.checkoutUrl };
  }
}
