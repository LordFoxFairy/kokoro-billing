import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { assertDefined } from "../assert-defined.js";
import { createBillingRuntime } from "../../src/bootstrap/create-billing-runtime.js";
import type { BillingRuntime } from "../../src/bootstrap/create-billing-runtime.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";
import {
  createBillingConnection,
  runWithBillingContext,
} from "../../src/infrastructure/postgres/connection.js";
import { OutboxWorker } from "../../src/infrastructure/postgres/outbox-worker.js";
import { createProviderRegistry } from "../../src/infrastructure/providers/payment/provider-registry.js";
import {
  createPostgresCheckoutService,
  createPostgresProviderEventProcessor,
  createPostgresBillingSettlementService,
  createPostgresBillingReversalService,
  createPostgresSubscriptionGrantService,
} from "../../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
const accepted = z.object({
  data: z.object({ event_id: z.string(), status: z.string() }),
});
const outboxPayload = z.object({ providerEventId: z.string() });

// Real local PostgreSQL + runtime HTTP injection + official SDK test signatures.
// No Stripe API key/session creation or platform request: this is not a Stripe sandbox.
describe.skipIf(!databaseUrl || !redisUrl)(
  "Stripe payment gating through the durable receipt chain",
  () => {
    it("ignores unpaid, fulfills later paid once, and survives replay/late unpaid without credit changes", async () => {
      const connection = await createBillingConnection(
        assertDefined(databaseUrl),
      );
      let leaseConnection:
        Awaited<ReturnType<typeof createBillingConnection>> | undefined;
      let runtime: BillingRuntime | undefined;
      const tenantId = randomUUID();
      const subjectId = randomUUID();
      const offerId = randomUUID();
      const revisionId = randomUUID();
      const accountRef = `acct_${randomUUID()}`;
      const secret = `whsec_${randomUUID()}`;
      const stripe = new Stripe("unused-local-signature-client");
      try {
        leaseConnection = await createBillingConnection(
          assertDefined(databaseUrl),
        );
        await connection.execute(
          "INSERT INTO payment_provider_account (provider_account_id, tenant_id, provider, external_account_ref, status) VALUES ($1, $2, 'stripe', $3, 'active')",
          [randomUUID(), tenantId, accountRef],
        );
        await connection.execute(
          "INSERT INTO entitlement_offer (offer_id, tenant_id, offer_key, status) VALUES ($1, $2, 's0-paid-credit', 'active')",
          [offerId, tenantId],
        );
        await connection.execute(
          `INSERT INTO entitlement_offer_revision
        (offer_revision_id, offer_id, tenant_id, revision, name, currency, amount_minor, credit_micros, billing_interval, status, published_at)
        VALUES ($1, $2, $3, 1, 'S0 paid credit', 'USD', 1999, 1000000, 'once', 'published', CURRENT_TIMESTAMP(3))`,
          [revisionId, offerId, tenantId],
        );
        const checkout = await createPostgresCheckoutService(connection).create(
          {
            tenantId,
            subjectId,
            idempotencyKey: randomUUID(),
            offerRevisionId: revisionId,
            amountMinor: 1999,
            currency: "USD",
            quoteSnapshot: { key: "s0-paid-credit", creditMicros: "1000000" },
            expiresAt: new Date(Date.now() + 300_000),
          },
        );
        const sessionId = `cs_${randomUUID()}`;
        const paymentIntent = `pi_${randomUUID()}`;
        // Persist the local fixture's hosted-session binding, without a Stripe API request.
        await connection.execute(
          "UPDATE payment_checkout SET provider = 'stripe', provider_account_ref = $1, provider_session_id = $2, status = 'pending_payment' WHERE tenant_id = $3 AND checkout_id = $4",
          [accountRef, sessionId, tenantId, checkout.checkoutId],
        );
        runtime = await createBillingRuntime(
          readBillingRuntimeConfig({
            DATABASE_URL: assertDefined(databaseUrl),
            REDIS_URL: assertDefined(redisUrl),
            BILLING_AUTH_MODE: "jwks",
            BILLING_AUTH_JWKS_URL: "http://127.0.0.1:1/unused-jwks",
            INTERNAL_SERVICE_SECRET: randomUUID(),
            BILLING_BFF_SERVICE_TOKEN: randomUUID(),
            BILLING_OPERATOR_PROXY_SECRET: randomUUID(),
            BILLING_ENABLED_PROVIDERS: "stripe",
            PROVIDER_WEBHOOK_SECRETS_JSON: JSON.stringify({ stripe: secret }),
          }),
        );
        const server = runtime.server;
        const processor = createPostgresProviderEventProcessor(
          connection,
          createProviderRegistry(["stripe"]),
          createPostgresBillingSettlementService(connection),
          createPostgresBillingReversalService(connection),
          createPostgresSubscriptionGrantService(connection),
        );
        const worker = new OutboxWorker(
          connection,
          "payment_outbox",
          30,
          "PaymentProviderEventReceived",
          3,
          tenantId,
          leaseConnection,
        );
        const dispatch = () =>
          runWithBillingContext(() =>
            worker.processOnce(async (event) => {
              await processor.process(
                outboxPayload.parse(event.payload).providerEventId,
              );
            }),
          );
        const event = (type: string, paymentStatus: string) => ({
          id: `evt_${randomUUID()}`,
          type,
          account: accountRef,
          data: {
            object: {
              id: sessionId,
              mode: "payment",
              payment_status: paymentStatus,
              subscription: null,
              payment_intent: paymentIntent,
              metadata: { checkoutId: checkout.checkoutId },
            },
          },
        });
        const send = async (
          payload: ReturnType<typeof event>,
          signingSecret = secret,
        ) => {
          const body = JSON.stringify(payload);
          return server.inject({
            method: "POST",
            url: "/v1/webhooks/payment/stripe",
            headers: {
              "content-type": "application/json",
              "stripe-signature": stripe.webhooks.generateTestHeaderString({
                payload: body,
                secret: signingSecret,
              }),
            },
            payload: body,
          });
        };
        const effects = async () => {
          const [rows] = await connection.query<
            {
              settlements: number;
              accounts: number;
              grants: number;
              journals: number;
              available: string;
              granted: string;
              journaled: string;
            }[]
          >(
            `SELECT
          (SELECT count(*)::integer FROM payment_settlement WHERE tenant_id = $1) AS settlements,
          (SELECT count(*)::integer FROM entitlement_credit_account WHERE tenant_id = $1) AS accounts,
          (SELECT count(*)::integer FROM entitlement_credit_grant WHERE tenant_id = $1) AS grants,
          (SELECT count(*)::integer FROM entitlement_credit_journal WHERE tenant_id = $1) AS journals,
          (SELECT COALESCE(sum(available_micros), 0)::text FROM entitlement_credit_account WHERE tenant_id = $1) AS available,
          (SELECT COALESCE(sum(original_micros), 0)::text FROM entitlement_credit_grant WHERE tenant_id = $1) AS granted,
          (SELECT COALESCE(sum(amount_micros), 0)::text FROM entitlement_credit_journal WHERE tenant_id = $1) AS journaled`,
            [tenantId],
          );
          return assertDefined(rows[0]);
        };
        const empty = {
          settlements: 0,
          accounts: 0,
          grants: 0,
          journals: 0,
          available: "0",
          granted: "0",
          journaled: "0",
        };
        const once = {
          settlements: 1,
          accounts: 1,
          grants: 1,
          journals: 1,
          available: "1000000",
          granted: "1000000",
          journaled: "1000000",
        };
        const receipt = async (externalId: string) => {
          const [rows] = await connection.query<
            {
              tenant_id: string;
              processing_status: string;
              event_type: string;
              published: boolean;
              attempts: number;
            }[]
          >(
            `SELECT e.tenant_id, e.processing_status, e.event_type, o.published_at IS NOT NULL AS published, o.attempts
          FROM payment_provider_event e JOIN payment_outbox o ON o.tenant_id = e.tenant_id AND o.aggregate_id = e.provider_event_id
          WHERE e.tenant_id = $1 AND e.external_event_id = $2 AND o.event_type = 'PaymentProviderEventReceived'`,
            [tenantId, externalId],
          );
          expect(rows).toHaveLength(1);
          return assertDefined(rows[0]);
        };
        const checkoutState = async () => {
          const [rows] = await connection.query<{ status: string }[]>(
            "SELECT status FROM payment_checkout WHERE tenant_id = $1 AND checkout_id = $2",
            [tenantId, checkout.checkoutId],
          );
          return assertDefined(rows[0]).status;
        };
        const invalid = await send(
          event("checkout.session.completed", "paid"),
          "incorrect-secret",
        );
        expect(invalid.statusCode).toBe(401);
        const [invalidInbox] = await connection.query<{ count: number }[]>(
          "SELECT count(*)::integer AS count FROM payment_provider_event WHERE tenant_id = $1",
          [tenantId],
        );
        expect(invalidInbox).toEqual([{ count: 0 }]);
        expect(await effects()).toEqual(empty);

        const unpaid = event("checkout.session.completed", "unpaid");
        expect((await send(unpaid)).statusCode).toBe(202);
        expect(await effects()).toEqual(empty);
        expect(await dispatch()).toBe("published");
        expect(
          await effects(),
          "unpaid Checkout must not create settlement/account/grant/journal",
        ).toEqual(empty);
        expect(await receipt(unpaid.id)).toEqual({
          tenant_id: tenantId,
          processing_status: "ignored",
          event_type: unpaid.type,
          published: true,
          attempts: 1,
        });
        expect(await checkoutState()).toBe("pending_payment");

        const paid = event("checkout.session.async_payment_succeeded", "paid");
        const paidResponse = await send(paid);
        expect(paidResponse.statusCode).toBe(202);
        const paidReceipt = accepted.parse(paidResponse.json<unknown>()).data;
        expect(await effects()).toEqual(empty);
        expect(await dispatch()).toBe("published");
        expect(await effects()).toEqual(once);
        expect(await receipt(paid.id)).toEqual({
          tenant_id: tenantId,
          processing_status: "processed",
          event_type: "payment_succeeded",
          published: true,
          attempts: 1,
        });
        const [settlements] = await connection.query<
          {
            checkout_id: string;
            provider_event_id: string;
            external_payment_ref: string;
            amount_minor: string;
            currency: string;
          }[]
        >(
          "SELECT checkout_id, provider_event_id, external_payment_ref, amount_minor, currency FROM payment_settlement WHERE tenant_id = $1",
          [tenantId],
        );
        expect(settlements).toEqual([
          {
            checkout_id: checkout.checkoutId,
            provider_event_id: paidReceipt.event_id,
            external_payment_ref: paymentIntent,
            amount_minor: "1999",
            currency: "USD",
          },
        ]);
        const [creditRecipients] = await connection.query<
          { subject_id: string; available_micros: string }[]
        >(
          "SELECT subject_id, available_micros FROM entitlement_credit_account WHERE tenant_id = $1",
          [tenantId],
        );
        expect(creditRecipients).toEqual([
          { subject_id: subjectId, available_micros: "1000000" },
        ]);
        const postPaymentState = await checkoutState();

        const replay = await send(paid);
        expect(replay.statusCode).toBe(202);
        expect(accepted.parse(replay.json<unknown>()).data).toEqual({
          event_id: paidReceipt.event_id,
          status: "processed",
        });
        expect(await dispatch()).toBe(false);
        expect(await effects()).toEqual(once);
        expect(await receipt(paid.id)).toMatchObject({
          processing_status: "processed",
          attempts: 1,
          published: true,
        });

        const late = event("checkout.session.completed", "unpaid");
        expect((await send(late)).statusCode).toBe(202);
        expect(await dispatch()).toBe("published");
        expect(await effects()).toEqual(once);
        expect(await receipt(late.id)).toEqual({
          tenant_id: tenantId,
          processing_status: "ignored",
          event_type: late.type,
          published: true,
          attempts: 1,
        });
        expect(await checkoutState()).toBe(postPaymentState);
        expect(await dispatch()).toBe(false);
      } finally {
        await Promise.all([
          runtime?.close(),
          leaseConnection?.end(),
          connection.end(),
        ]);
      }
    });
  },
);
