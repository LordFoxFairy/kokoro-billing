import { InternalServerErrorException } from "@nestjs/common";
import type { TransactionService } from "../../database/transaction.service.js";
import type {
  CatalogItem,
  CatalogResponse,
} from "../../generated/billing-api/types.gen.js";
import { encodeCatalogCursor, type CatalogQuery } from "./catalog.query.js";

/** The sole canonical catalog persistence query and row-to-wire mapping. */
export class CatalogRepository {
  constructor(private readonly transactions: TransactionService) {}
  async list(tenantId: string, query: CatalogQuery): Promise<CatalogResponse> {
    const client = this.transactions.requireActiveTransaction(
      tenantId,
      "readOnlySnapshot",
    );
    const clock = await client.$queryRaw<
      { instant: Date }[]
    >`SELECT CURRENT_TIMESTAMP(3) AS instant`;
    const instant = clock[0]?.instant;
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime()))
      throw new InternalServerErrorException();
    // No FK: never silently turn an otherwise eligible orphan/cross-tenant
    // revision into an empty page. Inspect only this tenant's candidate facts.
    const corrupt = await client.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM billing_offer_revision r
      WHERE r.tenant_id = ${tenantId} AND r.status = 'published'
        AND r.deleted_at IS NULL AND r.published_at IS NOT NULL AND r.published_at <= ${instant}
        AND NOT EXISTS (SELECT 1 FROM billing_offer o WHERE o.id = r.offer_id AND o.tenant_id = ${tenantId})
      LIMIT 1`;
    if (corrupt.length !== 0) throw new InternalServerErrorException();
    const cursor = query.cursor;
    const rows = await client.$queryRaw<
      {
        id: string;
        offer_key: string;
        revision: number;
        name: string;
        amount_minor: bigint;
        currency_code: string;
        credit_micros: bigint;
        billing_interval: string;
      }[]
    >`
      SELECT r.id, o.offer_key, r.revision, r.name, r.amount_minor,
        r.currency_code, r.credit_micros, r.billing_interval
      FROM billing_offer_revision r
      JOIN billing_offer o ON o.id = r.offer_id AND o.tenant_id = ${tenantId}
      WHERE r.tenant_id = ${tenantId} AND o.status = 'active' AND r.status = 'published'
        AND r.deleted_at IS NULL AND r.published_at IS NOT NULL AND r.published_at <= ${instant}
        AND NOT EXISTS (SELECT 1 FROM billing_offer_revision newer
          WHERE newer.tenant_id = ${tenantId} AND newer.offer_id = r.offer_id
            AND newer.status = 'published' AND newer.deleted_at IS NULL
            AND newer.published_at IS NOT NULL AND newer.published_at <= ${instant}
            AND (newer.revision > r.revision OR (newer.revision = r.revision AND newer.id < r.id)))
        AND (${cursor === undefined}::boolean
          OR (o.offer_key COLLATE "C" > ${cursor?.offerKey ?? ""}::text COLLATE "C"
            OR (o.offer_key = ${cursor?.offerKey ?? ""}::text AND (r.revision < ${cursor?.revision ?? 0}::integer
              OR (r.revision = ${cursor?.revision ?? 0}::integer AND r.id > ${cursor?.revisionId ?? "00000000-0000-0000-0000-000000000000"}::uuid)))))
      ORDER BY o.offer_key COLLATE "C" ASC, r.revision DESC, r.id ASC
      LIMIT ${query.limit + 1}`;
    const items = rows.map((row): CatalogItem => {
      const text = (value: unknown): value is string =>
        typeof value === "string" &&
        [...value].length > 0 &&
        [...value].length <= 255 &&
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value);
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
          row.id,
        ) ||
        !text(row.offer_key) ||
        !text(row.name) ||
        !Number.isInteger(row.revision) ||
        row.revision < 1 ||
        row.revision > 2147483647 ||
        typeof row.amount_minor !== "bigint" ||
        row.amount_minor <= 0n ||
        row.amount_minor > 9223372036854775807n ||
        typeof row.credit_micros !== "bigint" ||
        row.credit_micros < 0n ||
        row.credit_micros > 9223372036854775807n ||
        !/^[A-Z]{3}$/u.test(row.currency_code) ||
        (row.billing_interval !== "once" &&
          row.billing_interval !== "month" &&
          row.billing_interval !== "year")
      )
        throw new InternalServerErrorException();
      return {
        offer_revision_id: row.id,
        offer_key: row.offer_key,
        name: row.name,
        amount_minor: row.amount_minor.toString(),
        currency_code: row.currency_code,
        credit_micros: row.credit_micros.toString(),
        billing_interval: row.billing_interval,
      };
    });
    const hasMore = rows.length > query.limit;
    const last = rows[query.limit - 1];
    return {
      data: {
        items: items.slice(0, query.limit),
        page: {
          next_cursor:
            hasMore && last
              ? encodeCatalogCursor({
                  version: 1,
                  scope: "commerce.catalog",
                  tenantId,
                  offerKey: last.offer_key,
                  revision: last.revision,
                  revisionId: last.id,
                })
              : null,
        },
      },
    };
  }
}
