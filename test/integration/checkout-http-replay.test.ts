import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBillingConnection,
  type RowDataPacket,
} from "../../src/infrastructure/postgres/connection.js";
import { createPostgresCheckoutService } from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

const requiredDatabaseUrl = (): string => {
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  return databaseUrl;
};

integration("checkout durable service replay", () => {
  it("replays reordered canonical JSON after the offer is disabled and rejects payload drift", async () => {
    const connection = await createBillingConnection(requiredDatabaseUrl());
    const checkout = createPostgresCheckoutService(connection);
    const tenantId = randomUUID();
    const subjectId = `subject-${randomUUID()}`;
    const offerId = randomUUID();
    const revisionId = randomUUID();
    const idempotencyKey = `checkout-${randomUUID()}`;
    const firstPayload = {
      offer_revision_id: revisionId,
      amount_minor: "1999",
      currency: "USD",
      quote_snapshot: {
        key: "pro",
        creditMicros: "1000",
        metadata: { region: "global", display: { badge: "popular", rank: 1 } },
        tiers: [
          { name: "base", amount: 1000 },
          { amount: 2000, name: "plus" },
        ],
      },
    };

    try {
      await connection.execute(
        "INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'pro', 'active')",
        [offerId, tenantId],
      );
      await connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
         VALUES ($1, $2, $3, 1, 'Pro', 'USD', 1999, 1000, 'month', 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, offerId, tenantId],
      );

      const input = {
        tenantId,
        subjectId,
        idempotencyKey,
        offerRevisionId: revisionId,
        amountMinor: 1999,
        currency: "USD",
        quoteSnapshot: firstPayload.quote_snapshot,
        expiresAt: new Date(Date.now() + 300_000),
      };
      const first = await checkout.create(input);
      await connection.execute(
        "UPDATE entitlement_offer SET status = 'disabled' WHERE tenant_id = $1 AND offer_id = $2",
        [tenantId, offerId],
      );
      const reorderedReplay = await checkout.create({
        ...input,
        quoteSnapshot: {
          tiers: [
            { amount: 1000, name: "base" },
            { name: "plus", amount: 2000 },
          ],
          metadata: {
            display: { rank: 1, badge: "popular" },
            region: "global",
          },
          creditMicros: "1000",
          key: "pro",
        },
      });
      expect(reorderedReplay.checkoutId).toBe(first.checkoutId);
      await expect(
        checkout.create({
          ...input,
          quoteSnapshot: {
            ...firstPayload.quote_snapshot,
            metadata: { region: "changed" },
          },
        }),
      ).rejects.toThrow("billing.idempotency_conflict");
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT checkout_id FROM payment_checkout WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, idempotencyKey],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });
});
