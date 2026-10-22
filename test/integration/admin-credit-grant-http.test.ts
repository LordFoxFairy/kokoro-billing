import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { CreditEffects } from "../../src/modules/credit/credit.service.js";
import type {
  AdminCreditGrantResponse,
  CreditAccountResponse,
  CreditLedgerResponse,
} from "../../src/generated/billing-api/types.gen.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
const path = "/v1/admin/billing/credit-grants";
const auth = {
  internal: "funding-real-internal-secret-000000001",
  bearer: "funding-real-bff-bearer-token-00000001",
  operator: "funding-real-operator-secret-000000001",
};
const identity = (value: string) =>
  "u1." + Buffer.from(value).toString("base64url");
function headers(key: string, tenant = "tenant-a", actor = "operator-a") {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${auth.bearer}`,
    "x-kokoro-service": "web-bff",
    "x-kokoro-internal-secret": auth.internal,
    "x-kokoro-proxy-secret": auth.operator,
    "x-kokoro-tenant-id": identity(tenant),
    "x-kokoro-subject": identity(actor),
    "idempotency-key": key,
  };
}
function command() {
  return {
    funding_id: randomUUID(),
    subject_id: "recipient-a",
    amount_credits: "1000",
    reason: "Non-cash isolated credit acceptance",
    effective_at: "2026-01-01T00:00:00.000Z",
  };
}

describe.skipIf(adminUrl === undefined)(
  "administrative credit funding HTTP with real owner transactions",
  () => {
    let fixture: PrismaDatabaseFixture | undefined;
    let app: NestFastifyApplication | undefined;
    beforeEach(async () => {
      fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
      const url = new URL(fixture.url);
      url.searchParams.set("schema", "kokoro_billing");
      const module = await Test.createTestingModule({
        imports: [
          AppModule.register(
            readBillingRuntimeConfig({
              DATABASE_URL: url.toString(),
              BILLING_AUTH_MODE: "jwks",
              BILLING_AUTH_JWKS_URL: "https://iam.example.test/iam/jwks",
              BILLING_AUTH_JWT_ISSUER: "https://iam.example.test/iam",
              BILLING_AUTH_JWT_AUDIENCE: "https://kokoro.dev/resources/billing",
              INTERNAL_SERVICE_SECRET: auth.internal,
              BILLING_BFF_SERVICE_TOKEN: auth.bearer,
              BILLING_OPERATOR_PROXY_SECRET: auth.operator,
            }),
          ),
        ],
      }).compile();
      app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
        { logger: false },
      );
      await app.init();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        await app?.close();
      } finally {
        app = undefined;
        await fixture?.close();
        fixture = undefined;
      }
    });
    const db = () => assertDefined(fixture).client;
    const server = () => assertDefined(app);
    const post = (
      payload: ReturnType<typeof command>,
      key = randomUUID(),
      tenant = "tenant-a",
    ) =>
      server().inject({
        method: "POST",
        url: path,
        headers: headers(key, tenant),
        payload,
      });
    async function funds() {
      // Stringify in PostgreSQL, not JS: exact comparison of int64 and timestamps.
      const result = await assertDefined(fixture).pool.query<{
        snapshot: string;
      }>(`SELECT jsonb_build_object(
      'accounts', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM billing_credit_account t),
      'grants', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM billing_credit_grant t),
      'journals', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM billing_credit_journal t),
      'audits', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM billing_audit_event t),
      'receipts', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM billing_command_receipt t),
      'keys', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM billing_command_key_binding t)
    )::text AS snapshot`);
      return assertDefined(result.rows[0]).snapshot;
    }

    it("persists one grant, audited operator and exact own balance/ledger across lost ACK retries", async () => {
      const payload = command();
      const key = randomUUID();
      const issued = await post(payload, key);
      expect(issued.statusCode).toBe(201);
      const result = issued.json<AdminCreditGrantResponse>();
      for (const retryKey of [key, randomUUID()]) {
        const retry = await post(payload, retryKey);
        expect(retry.statusCode).toBe(201);
        expect(retry.json()).toEqual(result);
      }
      expect(await db().billing_credit_account.count()).toBe(1);
      expect(await db().billing_credit_grant.count()).toBe(1);
      expect(await db().billing_credit_journal.count()).toBe(1);
      expect(await db().billing_command_receipt.count()).toBe(1);
      expect(await db().billing_command_key_binding.count()).toBe(2);
      expect(await db().billing_audit_event.findMany()).toMatchObject([
        {
          tenant_id: "tenant-a",
          operator_id: "operator-a",
          subject_id: payload.subject_id,
          action: "credit.grant",
          resource_id: result.data.grant_id,
          reason: payload.reason,
          payload_json: {
            amountMicros: "1000000000",
            programKey: "admin_credit_v1",
            sourceRef: payload.funding_id,
          },
        },
      ]);
      const beforeReads = await funds();
      const personalHeaders = headers(
        randomUUID(),
        "tenant-a",
        payload.subject_id,
      );
      const account = await server().inject({
        method: "GET",
        url: "/v1/billing/me/credit-account",
        headers: personalHeaders,
      });
      expect(account.statusCode).toBe(200);
      expect(account.json<CreditAccountResponse>()).toEqual({
        data: {
          credit_account_id: result.data.account_id,
          status: "active",
          available_micros: "1000000000",
          held_micros: "0",
        },
      });
      const ledger = await server().inject({
        method: "GET",
        url: "/v1/billing/me/credit-ledger",
        headers: personalHeaders,
      });
      expect(ledger.statusCode).toBe(200);
      expect(ledger.json<CreditLedgerResponse>()).toMatchObject({
        data: {
          items: [
            {
              journal_id: result.data.journal_id,
              sequence: "1",
              delta_micros: "1000000000",
              balance_after_micros: "1000000000",
              source_kind: "admin_credit",
              source_ref: payload.funding_id,
            },
          ],
          page: { next_cursor: null },
        },
      });
      expect(ledger.json<CreditLedgerResponse>().data.items).toHaveLength(1);
      expect(await funds()).toBe(beforeReads);
    });

    it("serializes concurrent same-identity requests with different keys into one financial effect", async () => {
      const payload = command();
      const results = await Promise.all([
        post(payload),
        post(payload),
        post(payload),
      ]);
      for (const response of results) {
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual(results[0]?.json());
      }
      expect(await db().billing_credit_grant.count()).toBe(1);
      expect(await db().billing_credit_journal.count()).toBe(1);
      expect(await db().billing_audit_event.count()).toBe(1);
      expect(await db().billing_command_receipt.count()).toBe(1);
      expect(await db().billing_command_key_binding.count()).toBe(3);
      expect(
        await db().billing_credit_account.findFirstOrThrow(),
      ).toMatchObject({ available_micros: 1_000_000_000n, held_micros: 0n });
    });

    it("rejects drift of all financial command fields with the original or a replacement key without any writes", async () => {
      const payload = command();
      const key = randomUUID();
      expect((await post(payload, key)).statusCode).toBe(201);
      const before = await funds();
      const changes = [
        { amount_credits: "1001" },
        { reason: "Changed audit reason" },
        { subject_id: "different-recipient" },
        { effective_at: "2026-01-02T00:00:00.000Z" },
      ];
      for (const patch of changes) {
        for (const retryKey of [key, randomUUID()]) {
          const response = await post({ ...payload, ...patch }, retryKey);
          expect(response.statusCode).toBe(409);
          expect(await funds()).toBe(before);
        }
      }
      expect(
        (await post({ ...payload, funding_id: randomUUID() }, key)).statusCode,
      ).toBe(409);
      expect(await funds()).toBe(before);
    });

    it("denies new grants to a disabled account but preserves the immutable receipt of an earlier grant", async () => {
      const payload = command();
      const key = randomUUID();
      const issued = await post(payload, key);
      expect(issued.statusCode).toBe(201);
      const result = issued.json<AdminCreditGrantResponse>();
      await db().billing_credit_account.update({
        where: { id: result.data.account_id },
        data: { status: "disabled" },
      });
      const before = await funds();
      expect((await post(command())).statusCode).toBe(403);
      expect(await funds()).toBe(before);
      const replay = await post(payload, key);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(result);
      expect(await funds()).toBe(before);
    });

    it("isolates trusted tenant ledgers and rejects caller tenant/actor injection before mutations", async () => {
      const payload = command();
      const key = randomUUID();
      const first = await post(payload, key);
      const second = await post(payload, key, "tenant-b");
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.json<AdminCreditGrantResponse>().data.account_id).not.toBe(
        second.json<AdminCreditGrantResponse>().data.account_id,
      );
      expect(await db().billing_credit_account.count()).toBe(2);
      expect(await db().billing_credit_grant.count()).toBe(2);
      const before = await funds();
      for (const patch of [
        { tenant_id: "tenant-b" },
        { actor_id: "operator-b" },
      ]) {
        const response = await server().inject({
          method: "POST",
          url: path,
          headers: headers(randomUUID()),
          payload: { ...command(), ...patch },
        });
        expect(response.statusCode).toBe(400);
        expect(await funds()).toBe(before);
      }
      const forged = await server().inject({
        method: "POST",
        url: path,
        headers: { ...headers(randomUUID()), "x-kokoro-subject": "operator-b" },
        payload: command(),
      });
      expect(forged.statusCode).toBe(403);
      expect(await funds()).toBe(before);
      const stranger = await server().inject({
        method: "GET",
        url: "/v1/billing/me/credit-account",
        headers: headers(randomUUID(), "tenant-c", payload.subject_id),
      });
      expect(stranger.statusCode).toBe(404);
      expect(await funds()).toBe(before);
    });

    it("rolls back account, grant, journal, audit and receipt together when audit fails, then accepts the original retry", async () => {
      const payload = command();
      const key = randomUUID();
      const before = await funds();
      const audit = vi
        .spyOn(server().get(AuditAppender), "append")
        .mockRejectedValueOnce(new Error("fixture audit sink failure"));
      const failed = await post(payload, key);
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("fixture audit sink failure");
      expect(await funds()).toBe(before);
      audit.mockRestore();
      expect((await post(payload, key)).statusCode).toBe(201);
      expect(await db().billing_credit_grant.count()).toBe(1);
      expect(await db().billing_credit_journal.count()).toBe(1);
      expect(await db().billing_command_receipt.count()).toBe(1);
      expect(await db().billing_command_key_binding.count()).toBe(1);
      expect(await db().billing_audit_event.count()).toBe(1);
    });

    it("persists the largest whole-credit grant without Number conversion and atomically rejects int64 overflow", async () => {
      expect(
        (await post({ ...command(), amount_credits: "9223372036854" }))
          .statusCode,
      ).toBe(201);
      expect(
        await db().billing_credit_account.findFirstOrThrow(),
      ).toMatchObject({ available_micros: 9_223_372_036_854_000_000n });
      const before = await funds();
      // The canonical PostgreSQL int64 guard is the final storage limit. An
      // overflow must roll back the whole command, never clamp or partially issue.
      expect(
        (await post({ ...command(), amount_credits: "1" })).statusCode,
      ).toBe(500);
      expect(await funds()).toBe(before);
    });

    it("credits exactly once when the grant INSERT crosses its effective instant", async () => {
      // Only this owned temporary DB has this trigger. Waits until the actual
      // effective instant, rather than relying on scheduler sleeps to hit a race.
      await assertDefined(fixture).pool
        .query(`CREATE FUNCTION qa_delay_funding_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (NEW.effective_at - clock_timestamp()))) + 0.05);
        RETURN NEW;
      END $$;
      CREATE TRIGGER qa_delay_funding_insert BEFORE INSERT ON billing_credit_grant
        FOR EACH ROW EXECUTE FUNCTION qa_delay_funding_insert();`);
      const clock = await assertDefined(fixture).pool.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      const payload = {
        ...command(),
        amount_credits: "1",
        effective_at: new Date(
          assertDefined(clock.rows[0]).now.getTime() + 600,
        ).toISOString(),
      };
      const issued = await post(payload);
      expect(issued.statusCode).toBe(201);
      const { data } = issued.json<AdminCreditGrantResponse>();
      const grant = await db().billing_credit_grant.findUniqueOrThrow({
        where: { id: data.grant_id },
      });
      const account = await db().billing_credit_account.findUniqueOrThrow({
        where: { id: data.account_id },
      });
      expect(grant.status).toBe("pending");
      expect(account.available_micros).toBe(0n);
      const tx = server().get(TransactionService);
      const effects = server().get(CreditEffects);
      const refresh = () =>
        tx.runRoot(
          {
            tenantId: "tenant-a",
            actorId: "window-worker",
            operation: "credit.refresh_windows",
            mode: "write",
          },
          () => effects.refreshGrantWindows("tenant-a", data.account_id),
        );
      await refresh();
      await refresh();
      expect(
        await db().billing_credit_account.findUniqueOrThrow({
          where: { id: data.account_id },
        }),
      ).toMatchObject({ available_micros: 1_000_000n, held_micros: 0n });
      expect(
        await db().billing_credit_grant.findUniqueOrThrow({
          where: { id: data.grant_id },
        }),
      ).toMatchObject({ status: "active", remaining_micros: 1_000_000n });
      expect(await db().billing_credit_journal.count()).toBe(1);
      expect(await db().billing_command_receipt.count()).toBe(1);
      expect(
        await db().billing_audit_event.count({
          where: { action: "credit.grant" },
        }),
      ).toBe(1);
    });
  },
);
