import type { Connection, RowDataPacket } from '../../../src/infrastructure/postgres/connection.js';

export type CatalogPlan = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly currency: string;
  readonly amountMinor: string;
  readonly creditMicros: string;
  readonly billingInterval: 'once' | 'month' | 'year';
};

type CatalogRow = RowDataPacket & {
  offer_revision_id: string;
  offer_key: string;
  name: string;
  currency: string;
  amount_minor: string | number;
  credit_micros: string | number;
  billing_interval: CatalogPlan['billingInterval'];
};

export class CatalogService {
  public constructor(private readonly connection: Connection) {}

  /** Storefront exposes one current published revision per offer; historical revisions remain checkout-addressable. */
  public async listSellable(tenantId: string): Promise<CatalogPlan[]> {
    const [rows] = await this.connection.execute<CatalogRow[]>(
      `SELECT r.offer_revision_id, o.offer_key, r.name, r.currency, r.amount_minor,
              r.credit_micros, r.billing_interval
         FROM entitlement_offer_revision r
         INNER JOIN entitlement_offer o ON o.offer_id = r.offer_id AND o.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND o.status = 'active' AND r.status = 'published'
          AND r.deleted_at IS NULL AND r.published_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM entitlement_offer_revision newer
             WHERE newer.offer_id = r.offer_id AND newer.tenant_id = r.tenant_id
               AND newer.status = 'published' AND newer.deleted_at IS NULL AND newer.published_at IS NOT NULL
               AND newer.revision > r.revision
          )
        ORDER BY o.offer_key, r.revision DESC, r.offer_revision_id`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: row.offer_revision_id,
      key: row.offer_key,
      name: row.name,
      currency: row.currency,
      amountMinor: String(row.amount_minor),
      creditMicros: String(row.credit_micros),
      billingInterval: row.billing_interval,
    }));
  }

  /** Admin read surface: same published revisions, deliberately no hidden draft rows. */
  public async listAdmin(tenantId: string): Promise<CatalogPlan[]> {
    return this.listSellable(tenantId);
  }
}
