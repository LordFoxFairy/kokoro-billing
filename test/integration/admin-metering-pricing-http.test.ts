import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { readBillingRuntimeConfig } from "../../src/config/runtime-config.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { MeteringPricingRevisionRepository } from "../../src/modules/metering/metering-pricing-revision.repository.js";
import type {
  AdminMeteringPricingResponse,
  MeteringPublicationResponse,
} from "../../src/generated/billing-api/types.gen.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
const base = "/v1/admin/billing/metering";
const auth = {
  internal: "pricing-real-internal-secret-000000001",
  bearer: "pricing-real-bff-bearer-token-00000001",
  operator: "pricing-real-operator-secret-000000001",
};
const identity = (value: string) =>
  "u1." + Buffer.from(value).toString("base64url");
const headers = (key = randomUUID(), tenant = "pricing-tenant") => ({
  "content-type": "application/json",
  authorization: `Bearer ${auth.bearer}`,
  "x-kokoro-service": "web-bff",
  "x-kokoro-internal-secret": auth.internal,
  "x-kokoro-proxy-secret": auth.operator,
  "x-kokoro-tenant-id": identity(tenant),
  "x-kokoro-subject": identity("pricing-operator"),
  "idempotency-key": key,
});
const common = {
  effective_from: "2026-01-01T00:00:00.000Z",
  source_ref: "QA synthetic tariff; not a procurement price",
  verified_at: "2026-01-01T00:00:00.000Z",
};
const rate = {
  ...common,
  rates: [
    {
      provider_ref: "provider",
      environment: "test",
      pricing_account_ref: "account",
      model_ref: "model",
      model_version: "v1",
      bucket: "input_total",
      unit: "token",
      applicability: { kind: "all" },
      currency_code: "USD",
      minor_per_unit: { numerator: "1", denominator: "1000" },
    },
  ],
};
const policy = {
  ...common,
  currency_code: "USD",
  multiplier: { numerator: "7", denominator: "5" },
  credit_micros_per_minor: { numerator: "1000000", denominator: "1" },
  max_attempt_credits: "10",
};
const command = (configuration: unknown) => ({
  publication_id: randomUUID(),
  reason: "QA immutable pricing acceptance",
  configuration,
});

describe.skipIf(adminUrl === undefined)(
  "metering management real Nest HTTP and PostgreSQL",
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
    const pool = () => assertDefined(fixture).pool;
    const server = () => assertDefined(app);
    const post = (
      kind: "rate" | "policy",
      payload: ReturnType<typeof command>,
      key = randomUUID(),
      tenant = "pricing-tenant",
    ) =>
      server().inject({
        method: "POST",
        url: `${base}/${kind}-revisions`,
        headers: headers(key, tenant),
        payload,
      });
    const get = (tenant = "pricing-tenant") =>
      server().inject({
        method: "GET",
        url: `${base}/pricing`,
        headers: headers(randomUUID(), tenant),
      });
    async function counts() {
      const result = await pool().query<{
        rates: string;
        policies: string;
        receipts: string;
        audits: string;
        accounts: string;
        journals: string;
      }>(`SELECT
      (SELECT count(*)::text FROM billing_metering_rate_revision) AS rates,
      (SELECT count(*)::text FROM billing_metering_policy_revision) AS policies,
      (SELECT count(*)::text FROM billing_command_receipt) AS receipts,
      (SELECT count(*)::text FROM billing_audit_event) AS audits,
      (SELECT count(*)::text FROM billing_credit_account) AS accounts,
      (SELECT count(*)::text FROM billing_credit_journal) AS journals`);
      return result.rows;
    }
    it("reads honest nulls without opening accounts or creating configuration", async () => {
      const before = await counts();
      const result = await get();
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        data: { rate_revision: null, policy_revision: null },
      });
      expect(await counts()).toEqual(before);
    });
    it("publishes owner-bound exact prices and maximum budget, then reads the original persisted configuration", async () => {
      const rateCommand = command(rate),
        policyConfig = { ...policy, max_attempt_credits: "9223372036854" };
      const rateResult = await post("rate", rateCommand),
        policyResult = await post("policy", command(policyConfig));
      expect(rateResult.statusCode).toBe(201);
      expect(policyResult.statusCode).toBe(201);
      const result = await get();
      expect(result.statusCode).toBe(200);
      const data = result.json<AdminMeteringPricingResponse>().data;
      expect(data.rate_revision).toMatchObject({
        revision: "1",
        content_digest:
          rateResult.json<MeteringPublicationResponse>().data.content_digest,
        configuration: rate,
      });
      expect(data.policy_revision).toMatchObject({
        revision: "1",
        content_digest:
          policyResult.json<MeteringPublicationResponse>().data.content_digest,
        configuration: policyConfig,
      });
      const rows = await pool().query(
        "SELECT schema_version,profile_version,rounding_version,max_attempt_credits::text AS budget FROM billing_metering_policy_revision",
      );
      expect(rows.rows).toEqual([
        {
          schema_version: 2,
          profile_version: "2.0.0",
          rounding_version: "attempt-credit-ceil-v2",
          budget: "9223372036854",
        },
      ]);
      const audits = await pool().query(
        "SELECT operator_id,reason,payload_json FROM billing_audit_event ORDER BY action",
      );
      expect(audits.rows).toHaveLength(2);
      expect(audits.rows[0]).toMatchObject({
        operator_id: "pricing-operator",
        payload_json: { maxAttemptCredits: "9223372036854" },
      });
      expect(await counts()).toEqual([
        {
          rates: "1",
          policies: "1",
          receipts: "2",
          audits: "2",
          accounts: "0",
          journals: "0",
        },
      ]);
    });
    it("replays concurrent same/new-key policy commands once and rejects changed budget with no partial write", async () => {
      const input = command(policy),
        key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => post("policy", input, key)),
      );
      expect(responses.map((x) => x.statusCode)).toEqual(Array(6).fill(201));
      const original = assertDefined(
        responses[0],
      ).json<MeteringPublicationResponse>();
      for (const response of responses)
        expect(response.json()).toEqual(original);
      const replay = await post("policy", input);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(original);
      const before = await counts();
      const drift = await post("policy", {
        ...input,
        configuration: { ...policy, max_attempt_credits: "11" },
      });
      expect(drift.statusCode).toBe(409);
      expect(await counts()).toEqual(before);
      expect(await counts()).toEqual([
        {
          rates: "0",
          policies: "1",
          receipts: "1",
          audits: "1",
          accounts: "0",
          journals: "0",
        },
      ]);
    });
    it("separates tenant histories and binds identity only to authenticated context", async () => {
      const input = command(policy);
      expect((await post("policy", input)).statusCode).toBe(201);
      expect((await get("other-tenant")).json()).toEqual({
        data: { rate_revision: null, policy_revision: null },
      });
      expect(
        (await post("policy", input, randomUUID(), "other-tenant")).statusCode,
      ).toBe(201);
      const injected = await post("policy", {
        ...input,
        configuration: { ...policy, tenant_id: "other-tenant" },
      });
      expect(injected.statusCode).toBe(400);
      const result = await pool().query(
        "SELECT tenant_id,revision::text FROM billing_metering_policy_revision ORDER BY tenant_id",
      );
      expect(result.rows).toEqual([
        { tenant_id: "other-tenant", revision: "1" },
        { tenant_id: "pricing-tenant", revision: "1" },
      ]);
    });
    it("returns latest published future configuration, never mislabels it as active or falls back after corruption", async () => {
      expect((await post("policy", command(policy))).statusCode).toBe(201);
      const future = {
        ...policy,
        effective_from: "2030-01-01T00:00:00.000Z",
        max_attempt_credits: "20",
      };
      expect((await post("policy", command(future))).statusCode).toBe(201);
      const data = (await get()).json<AdminMeteringPricingResponse>().data;
      expect(data.policy_revision).toMatchObject({
        revision: "2",
        configuration: future,
      });
      await pool().query(
        "UPDATE billing_metering_policy_revision SET max_attempt_credits=21 WHERE revision=2",
      );
      const failed = await get();
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("max_attempt");
      expect((await counts())[0]).toMatchObject({
        policies: "2",
        receipts: "2",
        audits: "2",
        accounts: "0",
        journals: "0",
      });
    });
    it("keeps one repeatable-read snapshot while another real publisher appends a revision", async () => {
      expect((await post("policy", command(policy))).statusCode).toBe(201);
      const transactions = server().get(TransactionService),
        repository = server().get(MeteringPricingRevisionRepository);
      // A real listening server gives the concurrent writer its own request async
      // context. Fastify inject is in-process and inherits the caller's ALS scope.
      await server().listen(0, "127.0.0.1");
      const origin = await server().getUrl();
      await transactions.runRoot(
        {
          tenantId: "pricing-tenant",
          actorId: "pricing-operator",
          operation: "qa.pricing_snapshot",
          mode: "readOnlySnapshot",
        },
        async () => {
          const first = await repository.readLatest("pricing-tenant");
          expect(first.policy?.revision).toBe("1");
          const published = await fetch(origin + base + "/policy-revisions", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(
              command({ ...policy, max_attempt_credits: "20" }),
            ),
            signal: AbortSignal.timeout(3000),
          });
          const receipt: unknown = await published.json();
          expect(published.status).toBe(201);
          expect(receipt).toMatchObject({
            data: { kind: "policy", revision: "2" },
          });
          expect(await repository.readLatest("pricing-tenant")).toEqual(first);
        },
      );
      expect(
        (await get()).json<AdminMeteringPricingResponse>().data.policy_revision
          ?.revision,
      ).toBe("2");
    });
    it("rolls back failed audit and permits the exact original publication command to recover", async () => {
      const input = command(policy),
        key = randomUUID();
      const before = await counts();
      vi.spyOn(server().get(AuditAppender), "append").mockRejectedValueOnce(
        new Error("Injected private failure"),
      );
      const failed = await post("policy", input, key);
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain("private");
      expect(await counts()).toEqual(before);
      expect((await post("policy", input, key)).statusCode).toBe(201);
      expect(await counts()).toEqual([
        {
          rates: "0",
          policies: "1",
          receipts: "1",
          audits: "1",
          accounts: "0",
          journals: "0",
        },
      ]);
    });
    it("rejects ordinary and partial service capabilities before any policy/receipt effects", async () => {
      const before = await counts();
      const response = await server().inject({
        method: "POST",
        url: `${base}/policy-revisions`,
        headers: {
          ...headers(),
          "x-kokoro-service": "admin",
          "x-kokoro-role": "billing.admin",
        },
        payload: command(policy),
      });
      expect(response.statusCode).toBe(403);
      expect(await counts()).toEqual(before);
    });
  },
);
