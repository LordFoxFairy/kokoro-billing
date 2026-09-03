import type { RowDataPacket, SqlConnection } from '../../database.js';
import { z } from 'zod';

export type CatalogPlan = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly currency: string;
  readonly amountMinor: string;
  readonly creditMicros: string;
  readonly billingInterval: 'once' | 'month' | 'year';
};
export type CatalogPage = { readonly items: readonly CatalogPlan[]; readonly nextCursor?: string };

type CatalogRow = RowDataPacket & {
  offer_revision_id: string;
  offer_key: string;
  revision: number | string;
  name: string;
  currency: string;
  amount_minor: string | number;
  credit_micros: string | number;
  billing_interval: CatalogPlan['billingInterval'];
};
type CatalogCursor = { readonly version: 1; readonly scope: string; readonly tenantId: string; readonly offerKey: string; readonly revision: string; readonly offerRevisionId: string };
const catalogCursorSchema = z.object({
  version: z.literal(1), scope: z.string().min(1), tenantId: z.string().min(1), offerKey: z.string(),
  revision: z.string().regex(/^\d+$/u), offerRevisionId: z.string().min(1),
}).strict();

export class CatalogService {
  public constructor(private readonly connection: SqlConnection) {}

  public listSellable(tenantId: string, limit: number, cursor?: string): Promise<CatalogPage> {
    return this.listPublished(tenantId, limit, cursor, 'catalog.sellable');
  }

  public listAdmin(tenantId: string, limit: number, cursor?: string): Promise<CatalogPage> {
    return this.listPublished(tenantId, limit, cursor, 'catalog.admin');
  }

  private async listPublished(tenantId: string, requestedLimit: number, encodedCursor: string | undefined, scope: string): Promise<CatalogPage> {
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100);
    const cursor = encodedCursor === undefined ? undefined : decodeCatalogCursor(encodedCursor, tenantId, scope);
    const cursorPredicate = cursor === undefined
      ? ''
      : `AND (o.offer_key > $2 OR (o.offer_key = $2 AND (r.revision < $3 OR (r.revision = $3 AND r.offer_revision_id > $4))))`;
    const values = cursor === undefined
      ? [tenantId, limit + 1]
      : [tenantId, cursor.offerKey, cursor.revision, cursor.offerRevisionId, limit + 1];
    const limitPlaceholder = cursor === undefined ? '$2' : '$5';
    const [rows] = await this.connection.execute<CatalogRow[]>(
      `SELECT r.offer_revision_id, o.offer_key, r.revision, r.name, r.currency, r.amount_minor,
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
          ${cursorPredicate}
        ORDER BY o.offer_key ASC, r.revision DESC, r.offer_revision_id ASC
        LIMIT ${limitPlaceholder}`,
      values,
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toCatalogPlan);
    const last = pageRows.at(-1);
    if (!hasMore || last === undefined) return { items };
    return {
      items,
      nextCursor: encodeCatalogCursor({ version: 1, scope, tenantId, offerKey: last.offer_key, revision: String(last.revision), offerRevisionId: last.offer_revision_id }),
    };
  }
}

const toCatalogPlan = (row: CatalogRow): CatalogPlan => ({
  id: row.offer_revision_id,
  key: row.offer_key,
  name: row.name,
  currency: row.currency,
  amountMinor: String(row.amount_minor),
  creditMicros: String(row.credit_micros),
  billingInterval: row.billing_interval,
});

const encodeCatalogCursor = (cursor: CatalogCursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

function decodeCatalogCursor(value: string, tenantId: string, scope: string): CatalogCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const result = catalogCursorSchema.safeParse(parsed);
    if (!result.success || result.data.scope !== scope || result.data.tenantId !== tenantId) throw new Error();
    return result.data;
  } catch {
    throw new Error('billing.invalid_cursor');
  }
}
