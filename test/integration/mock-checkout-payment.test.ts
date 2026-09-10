import { assertDefined } from "../assert-defined.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import type { RowDataPacket } from "../../src/infrastructure/postgres/connection.js";
import { createProviderRegistry } from "../../src/infrastructure/providers/payment/provider-registry.js";
import { MockWebhookProvider } from "../doubles/payment/mock-webhook-provider.js";
import { OutboxWorker } from "../../src/infrastructure/postgres/outbox-worker.js";
import {
  createPostgresBillingReversalService,
  createPostgresBillingSettlementService,
  createPostgresCheckoutService,
  createPostgresProviderEventInboxService,
  createPostgresProviderEventProcessor,
  createPostgresSubscriptionGrantService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("mock checkout payment processor", () => {
  it("uses the normal settlement/fulfillment path and grants the published catalog credit", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const subjectId = randomUUID();
    const offerId = randomUUID();
    const revisionId = randomUUID();
    const externalEventId = `mock-${randomUUID()}`;
    const checkout = createPostgresCheckoutService(connection);
    const inbox = createPostgresProviderEventInboxService(connection);
    const processor = createPostgresProviderEventProcessor(
      connection,
      new Map([["mock", new MockWebhookProvider()]]),
      createPostgresBillingSettlementService(connection),
      createPostgresBillingReversalService(connection),
      createPostgresSubscriptionGrantService(connection),
    );
    try {
      await connection.execute(
        `INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'pro', 'active')`,
        [offerId, tenantId],
      );
      await connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
         VALUES ($1, $2, $3, 1, 'Pro', 'USD', 1999, 1000000, 'month', 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, offerId, tenantId],
      );
      const created = await checkout.create({
        tenantId,
        subjectId,
        idempotencyKey: `checkout-${randomUUID()}`,
        offerRevisionId: revisionId,
        amountMinor: 1999,
        currency: "USD",
        quoteSnapshot: { key: "pro", creditMicros: "1000000" },
        expiresAt: new Date(Date.now() + 300_000),
      });
      expect(created.checkoutId).toBeTypeOf("string");
      const event = await inbox.accept({
        tenantId,
        provider: "mock",
        externalEventId,
        eventType: "payment_succeeded",
        rawPayload: {
          eventId: externalEventId,
          eventType: "payment_succeeded",
          data: { orderId: created.checkoutId },
        },
        signatureValid: true,
      });
      const worker = new OutboxWorker(
        connection,
        "payment_outbox",
        30,
        "PaymentProviderEventReceived",
        10,
        tenantId,
      );
      expect(
        await worker.processOnce(async (outboxEvent) => {
          await processor.process(String(outboxEvent.payload.providerEventId));
        }),
      ).toBe("published");
      const [balances] = await connection.query<
        (RowDataPacket & { available_micros: number })[]
      >(
        "SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2",
        [tenantId, subjectId],
      );
      expect(Number(balances[0]?.available_micros)).toBe(1000000);
      const [states] = await connection.query<
        (RowDataPacket & { processing_status: string })[]
      >(
        "SELECT processing_status FROM payment_provider_event WHERE provider_event_id = $1",
        [event.providerEventId],
      );
      expect(states[0]?.processing_status).toBe("processed");
      const refundEventId = `refund-${randomUUID()}`;
      await inbox.accept({
        tenantId,
        provider: "mock",
        externalEventId: refundEventId,
        eventType: "refund_succeeded",
        signatureValid: true,
        rawPayload: {
          eventId: refundEventId,
          eventType: "refund_succeeded",
          data: { orderId: created.checkoutId },
        },
      });
      expect(
        await worker.processOnce(async (outboxEvent) => {
          await processor.process(String(outboxEvent.payload.providerEventId));
        }),
      ).toBe("published");
      const [refundedBalances] = await connection.query<
        (RowDataPacket & { available_micros: number })[]
      >(
        "SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2",
        [tenantId, subjectId],
      );
      expect(Number(refundedBalances[0]?.available_micros)).toBe(0);
    } finally {
      await connection.execute(
        "DELETE FROM entitlement_outbox WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_journal WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_grant WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_fulfillment_reversal WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_fulfillment WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_acquisition WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_account WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_reversal WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_settlement WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_outbox WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_provider_event WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_checkout WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_offer_revision WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_offer WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.end();
    }
  });

  it("processes a subscription period once and grants the published revision credit", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const offerId = randomUUID();
    const revisionId = randomUUID();
    const externalEventId = `stripe-${randomUUID()}`;
    const subscriptionId = `sub-${randomUUID()}`;
    const providerAccountId = randomUUID();
    const externalAccountRef = `acct-${randomUUID()}`;
    const periodStart = new Date(Date.now() + 60 * 60 * 1_000);
    const periodEnd = new Date(
      periodStart.getTime() + 30 * 24 * 60 * 60 * 1_000,
    );
    const inbox = createPostgresProviderEventInboxService(connection);
    const processor = createPostgresProviderEventProcessor(
      connection,
      createProviderRegistry(["stripe"]),
      createPostgresBillingSettlementService(connection),
      createPostgresBillingReversalService(connection),
      createPostgresSubscriptionGrantService(connection),
    );
    try {
      await connection.execute(
        `INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'pro-sub', 'active')`,
        [offerId, tenantId],
      );
      await connection.execute(
        `INSERT INTO entitlement_offer_revision
          (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
         VALUES ($1, $2, $3, 1, 'Pro subscription', 'USD', 1999, 2000000, 'month', 'published', CURRENT_TIMESTAMP(3))`,
        [revisionId, offerId, tenantId],
      );
      await connection.execute(
        `INSERT INTO payment_provider_account (provider_account_id, tenant_id, provider, external_account_ref, status)
         VALUES ($1, $2, 'stripe', $3, 'active')`,
        [providerAccountId, tenantId, externalAccountRef],
      );
      const event = await inbox.accept({
        tenantId,
        provider: "stripe",
        providerAccountRef: externalAccountRef,
        externalEventId,
        eventType: "subscription_updated",
        signatureValid: true,
        rawPayload: {
          id: externalEventId,
          type: "customer.subscription.updated",
          account: externalAccountRef,
          data: {
            object: {
              id: subscriptionId,
              status: "active",
              current_period_start: Math.floor(periodStart.getTime() / 1_000),
              current_period_end: Math.floor(periodEnd.getTime() / 1_000),
              metadata: { teamId, planId: revisionId },
            },
          },
        },
      });
      await processor.process(event.providerEventId);
      await processor.process(event.providerEventId);
      const [balances] = await connection.query<
        (RowDataPacket & { available_micros: number })[]
      >(
        "SELECT available_micros FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2",
        [tenantId, teamId],
      );
      expect(Number(balances[0]?.available_micros)).toBe(2000000);
      const [periods] = await connection.query(
        "SELECT period_id FROM payment_subscription_period WHERE provider_subscription_id IN (SELECT provider_subscription_id FROM payment_provider_subscription WHERE tenant_id = $1 AND subject_id = $2)",
        [tenantId, teamId],
      );
      expect(periods).toHaveLength(1);
      const [subscriptions] = await connection.query<
        (RowDataPacket & { provider_account_id: string })[]
      >(
        "SELECT provider_account_id FROM payment_provider_subscription WHERE tenant_id = $1 AND subject_id = $2",
        [tenantId, teamId],
      );
      expect(subscriptions[0]?.provider_account_id).toBe(providerAccountId);
      const [subscriptionGrants] = await connection.query<
        (RowDataPacket & { expires_at: Date | string })[]
      >(
        `SELECT g.expires_at FROM entitlement_credit_grant g WHERE g.tenant_id = $1 AND g.source_kind = 'subscription_period'`,
        [tenantId],
      );
      expect(
        new Date(assertDefined(subscriptionGrants[0]).expires_at).getTime(),
      ).toBe(Math.floor(periodEnd.getTime() / 1_000) * 1_000);
      const [terms] = await connection.query(
        "SELECT term_id, grant_micros, status FROM entitlement_subscription_term WHERE tenant_id = $1 AND subject_id = $2",
        [tenantId, teamId],
      );
      expect(terms).toHaveLength(1);
      const canceledEvent = await inbox.accept({
        tenantId,
        provider: "stripe",
        providerAccountRef: externalAccountRef,
        externalEventId: `stripe-canceled-${randomUUID()}`,
        eventType: "subscription_updated",
        signatureValid: true,
        rawPayload: {
          id: `stripe-canceled-${randomUUID()}`,
          type: "customer.subscription.deleted",
          account: externalAccountRef,
          data: {
            object: {
              id: subscriptionId,
              status: "canceled",
              metadata: { teamId, planId: revisionId },
            },
          },
        },
      });
      await processor.process(canceledEvent.providerEventId);
      const [subscriptionStates] = await connection.query<
        (RowDataPacket & { status: string })[]
      >(
        "SELECT status FROM payment_provider_subscription WHERE tenant_id = $1 AND subject_id = $2",
        [tenantId, teamId],
      );
      expect(subscriptionStates[0]?.status).toBe("canceled");
    } finally {
      await connection.execute(
        "DELETE FROM entitlement_outbox WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_subscription_term WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_journal WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_grant WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_fulfillment WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_acquisition WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_credit_account WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_subscription_period WHERE provider_subscription_id IN (SELECT provider_subscription_id FROM payment_provider_subscription WHERE tenant_id = $1)",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_provider_subscription WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM payment_provider_account WHERE provider_account_id = $1",
        [providerAccountId],
      );
      await connection.execute(
        "DELETE FROM payment_provider_event WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_offer_revision WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.execute(
        "DELETE FROM entitlement_offer WHERE tenant_id = $1",
        [tenantId],
      );
      await connection.end();
    }
  });
});

integration("persisted checkout quote input types", () => {
  it.each([
    ["decimal string", "100", true],
    ["number", 100, true],
    ["object", {}, false],
    ["empty array", [], false],
    ["numeric array", [100], false],
    ["boolean", true, false],
    ["null", null, false],
    ["missing", undefined, false],
  ] as const)(
    "validates %s before settlement or credit issuance",
    async (_name, creditMicros, valid) => {
      const connection = await createBillingConnection(
        assertDefined(databaseUrl),
      );
      const tenantId = randomUUID();
      const subjectId = randomUUID();
      const offerId = randomUUID();
      const revisionId = randomUUID();
      try {
        await connection.execute(
          `INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 'typed-quote', 'active')`,
          [offerId, tenantId],
        );
        await connection.execute(
          `INSERT INTO entitlement_offer_revision
        (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
        VALUES ($1, $2, $3, 1, 'Typed quote', 'USD', 100, 100, 'month', 'published', CURRENT_TIMESTAMP(3))`,
          [revisionId, offerId, tenantId],
        );
        const created = await createPostgresCheckoutService(connection).create({
          tenantId,
          subjectId,
          idempotencyKey: randomUUID(),
          offerRevisionId: revisionId,
          amountMinor: 100,
          currency: "USD",
          quoteSnapshot: { key: "typed-quote", creditMicros: "100" },
          expiresAt: new Date(Date.now() + 300_000),
        });
        await connection.execute(
          "UPDATE payment_checkout SET quote_snapshot_json = $1::jsonb WHERE tenant_id = $2 AND checkout_id = $3",
          [
            JSON.stringify({ key: "typed-quote", creditMicros }),
            tenantId,
            created.checkoutId,
          ],
        );
        const eventId = randomUUID();
        const event = await createPostgresProviderEventInboxService(
          connection,
        ).accept({
          tenantId,
          provider: "mock",
          externalEventId: eventId,
          eventType: "payment_succeeded",
          signatureValid: true,
          rawPayload: {
            eventId,
            eventType: "payment_succeeded",
            data: { orderId: created.checkoutId },
          },
        });
        const processor = createPostgresProviderEventProcessor(
          connection,
          new Map([["mock", new MockWebhookProvider()]]),
          createPostgresBillingSettlementService(connection),
          createPostgresBillingReversalService(connection),
          createPostgresSubscriptionGrantService(connection),
        );
        if (valid) await processor.process(event.providerEventId);
        else
          await expect(
            processor.process(event.providerEventId),
          ).rejects.toThrow("billing.checkout_quote_invalid");
        const [grants] = await connection.query<
          (RowDataPacket & { original_micros: string })[]
        >(
          "SELECT original_micros FROM entitlement_credit_grant WHERE tenant_id = $1",
          [tenantId],
        );
        const [settlements] = await connection.query(
          "SELECT settlement_id FROM payment_settlement WHERE tenant_id = $1",
          [tenantId],
        );
        const [journal] = await connection.query(
          "SELECT journal_id FROM entitlement_credit_journal WHERE tenant_id = $1",
          [tenantId],
        );
        const [states] = await connection.query<
          (RowDataPacket & { processing_status: string })[]
        >(
          "SELECT processing_status FROM payment_provider_event WHERE tenant_id = $1 AND provider_event_id = $2",
          [tenantId, event.providerEventId],
        );
        expect(grants).toEqual(valid ? [{ original_micros: "100" }] : []);
        expect(settlements).toHaveLength(valid ? 1 : 0);
        expect(journal).toHaveLength(valid ? 1 : 0);
        expect(states).toEqual([
          { processing_status: valid ? "processed" : "received" },
        ]);
      } finally {
        await connection.end();
      }
    },
  );
});
