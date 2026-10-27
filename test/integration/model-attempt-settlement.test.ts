import { request as httpRequest } from "node:http";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { BillingHttpModule } from "../../src/http/billing-http.module.js";
import type { AdmissionSettlementResponse } from "../../src/generated/billing-api/types.gen.js";
import { createHash, randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelAttemptSettlementService } from "../../src/modules/metering/model-attempt-settlement.service.js";
import { MeteringModule } from "../../src/modules/metering/metering.module.js";
import { DatabaseModule } from "../../src/database/database.module.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import {
  CreditService,
  CreditEffects,
} from "../../src/modules/credit/credit.service.js";
import { MeteringService } from "../../src/modules/metering/metering.service.js";
import { ModelAdmissionService } from "../../src/modules/metering/model-admission.service.js";
import { MeteringPricingSelectionService } from "../../src/modules/metering/metering-pricing-selection.service.js";
import { MeteringPricingPublicationService } from "../../src/modules/metering/metering-pricing-publication.service.js";
import { decodeAgentPreparedResponse } from "../../src/modules/metering/agent-prepared-call.js";
import { bindSealedAgentUsageEvidence } from "../../src/modules/metering/agent-usage-evidence.js";
import type { ModelUsageEvidence } from "../../src/generated/agent-usage-v2/types.gen.js";
import type { ModelAdmissionResult } from "../../src/modules/metering/model-admission.types.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";
import {
  canonicalFixture,
  frozenPricingFixture,
  usageFixture,
  encodeUsageFixture,
} from "../support/model-settlement.fixture.js";
const admin = process.env.SCHEMA_ADMIN_URL;
describe.skipIf(!admin)("actual model attempt settlement transaction", () => {
  let db: PrismaDatabaseFixture,
    app: TestingModule,
    tx: TransactionService,
    credit: CreditService,
    effects: CreditEffects,
    audit: AuditAppender;
  let admissions: ModelAdmissionService,
    service: ModelAttemptSettlementService,
    admitted: ModelAdmissionResult;
  let e: ModelUsageEvidence, head: string, online: boolean, reads: number;
  const context = () => ({
    tenantId: "qa-tenant",
    actorId: "qa-user",
    requestId: "qa-settlement",
    signal: new AbortController().signal,
  });
  const command = (key = "qa-model-settlement") => ({
    admissionId: admitted.admissionId,
    runId: e.identity.run_id,
    eventId: e.identity.event_id,
    revision: e.revision,
    digest: e.digest,
    idempotencyKey: key,
  });
  const update = () => {
    head = encodeUsageFixture(e);
  };
  const balances = async () => {
    const a = await db.client.billing_credit_account.findFirstOrThrow({
      where: { tenant_id: "qa-tenant", subject_id: "qa-user" },
    });
    return { available: a.available_micros, held: a.held_micros };
  };
  const facts = async () =>
    Promise.all(
      [
        "billing_admission",
        "billing_credit_account",
        "billing_credit_grant",
        "billing_credit_hold",
        "billing_credit_hold_allocation",
        "billing_credit_journal",
        "billing_usage_event",
        "billing_usage_settlement",
        "billing_command_receipt",
        "billing_command_key_binding",
        "billing_audit_event",
      ].map(async (t) =>
        (
          await db.pool.query<{ fact: string }>(
            `SELECT row_to_json(t)::text AS fact FROM ${t} t ORDER BY id`,
          )
        ).rows.map((r) => r.fact),
      ),
    );
  const auth = {
    mode: "jwks" as const,
    internalServiceSecret: "settlement-test-internal-secret-000001",
    bffServiceToken: "settlement-test-bff-bearer-token-00001",
    operatorProxySecret: "settlement-test-operator-secret-000001",
    jwksUrl: "http://127.0.0.1:1/unused-jwks",
    issuer: "https://qa.example.test/iam",
    audience: "https://kokoro.dev/resources/billing",
  };
  const headers = () => ({
    authorization: `Bearer ${auth.bffServiceToken}`,
    "x-kokoro-service": "web-bff",
    "x-kokoro-internal-secret": auth.internalServiceSecret,
    "x-kokoro-tenant-id":
      "u1." + Buffer.from("qa-tenant").toString("base64url"),
    "x-kokoro-subject": "u1." + Buffer.from("qa-user").toString("base64url"),
    "content-type": "application/json",
    "idempotency-key": "http-settlement-key",
  });
  const path = () =>
    `/v1/internal/billing/admissions/${admitted.admissionId}/settle`;
  const body = () => ({
    run_id: e.identity.run_id,
    evidence_event_id: e.identity.event_id,
    evidence_revision: e.revision,
    evidence_digest: e.digest,
  });
  async function withHttp(
    work: (http: NestFastifyApplication) => Promise<void>,
    enabled = true,
    deadline = 10000,
  ) {
    const module = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({ databaseUrl: db.url }),
        BillingHttpModule.register(
          auth,
          enabled
            ? {
                agent: {
                  baseUrl: "http://127.0.0.1:1",
                  machineBearerToken: "qa-reader",
                  deadlineMs: 1000,
                },
                iam: {
                  baseUrl: "http://127.0.0.1:1",
                  serviceCredentialFile:
                    "/private/never-read-during-settlement.json",
                  deadlineMs: 1000,
                },
                requestDeadlineMs: deadline,
              }
            : undefined,
        ),
      ],
    })
      .overrideProvider(ModelAdmissionService)
      .useValue(admissions)
      .overrideProvider(ModelAttemptSettlementService)
      .useValue(service)
      .compile();
    const http = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
      { logger: false },
    );
    try {
      await http.init();
      await http.getHttpAdapter().getInstance().ready();
      await work(http);
    } finally {
      await http.close();
    }
  }
  beforeEach(async () => {
    db = await createPrismaDatabaseFixture(assertDefined(admin));
    app = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({ databaseUrl: db.url }),
        MeteringModule,
      ],
    }).compile();
    await app.init();
    tx = app.get(TransactionService);
    credit = app.get(CreditService);
    effects = app.get(CreditEffects);
    audit = app.get(AuditAppender);
    e = usageFixture();
    online = true;
    reads = 0;
    const pricing = frozenPricingFixture(),
      publisher = app.get(MeteringPricingPublicationService);
    const metadata = {
      schemaVersion: "2" as const,
      tenantId: "qa-tenant",
      effectiveFrom: pricing.effectiveFrom,
      sourceRef: "explicit synthetic QA",
      verifiedAt: pricing.effectiveFrom,
      profileRef: pricing.profileRef,
    };
    const publication = {
      tenantId: "qa-tenant",
      actorId: "qa-admin",
      publicationIdentity: "qa-rate",
      idempotencyKey: "qa-rate-key",
      reason: "isolated model settlement",
    };
    const adminContext = {
      tenantId: "qa-tenant",
      operatorId: "qa-admin",
      role: "billing.admin",
    };
    await publisher.publishRate(adminContext, {
      ...publication,
      draft: { ...metadata, rates: pricing.rates },
    });
    await publisher.publishPolicy(adminContext, {
      ...publication,
      publicationIdentity: "qa-policy",
      idempotencyKey: "qa-policy-key",
      draft: {
        ...metadata,
        currencyCode: pricing.currencyCode,
        multiplier: pricing.policy.multiplier,
        creditMicrosPerMinor: pricing.policy.creditMicrosPerMinor,
        maxAttemptCredits: "10",
        roundingVersion: "attempt-credit-ceil-v2",
        failurePolicyRef: pricing.policy.failurePolicyRef,
      },
    });
    await credit.grant({
      tenantId: "qa-tenant",
      actorId: "qa-admin",
      subjectId: "qa-user",
      amountMicros: 100_000_000n,
      sourceKind: "admin",
      sourceRef: "qa-funding",
      programKey: "qa",
      reason: "isolated synthetic funding",
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      idempotencyKey: "qa-funding-key",
    });
    const { event_id: _event, ...identity } = e.identity;
    void _event;
    const part = (name: string, value: object) => {
      const raw = canonicalFixture(value);
      return {
        [name + "_bytes_base64url"]: Buffer.from(raw).toString("base64url"),
        [name + "_digest"]: createHash("sha256").update(raw).digest("hex"),
      };
    };
    const identityPart = part("attempt_binding", identity),
      plannedPart = part("planned", e.planned);
    admissions = new ModelAdmissionService(
      tx,
      app.get(CommandReceiptRepository),
      audit,
      effects,
      app.get(MeteringPricingSelectionService),
      {
        readPrepared: (input) => {
          tx.assertNoActiveTransaction();
          return Promise.resolve(
            decodeAgentPreparedResponse(
              Buffer.from(
                JSON.stringify({
                  data: {
                    binding_version: "2.0.0",
                    attempt_id: e.identity.attempt_id,
                    status: "authorization_pending",
                    ...part("attempt_binding", {
                      ...identity,
                      attempt_id: e.identity.attempt_id,
                    }),
                    ...plannedPart,
                    ...part("authorization", {
                      state: "requested_unknown",
                      request_ref:
                        e.identity.attempt_id === identity.attempt_id
                          ? "request-example"
                          : "next-request",
                    }),
                    final_request_binding_version: 1,
                    final_request_digest: "a".repeat(64),
                    prepared_at: e.execution.prepared_at,
                    observed_at: new Date().toISOString(),
                    lease_expires_at: "2099-01-01T00:00:00.000Z",
                  },
                  meta: { request_id: input.requestId },
                }),
              ),
              input.expected,
              input.requestId,
            ),
          );
        },
      },
      {
        authorize: () => {
          tx.assertNoActiveTransaction();
          return Promise.resolve({
            payerUserId: "qa-user",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
        },
      },
    );
    admitted = await admissions.create(
      context(),
      {
        runId: e.identity.run_id,
        attemptId: e.identity.attempt_id,
        requestRef: "request-example",
        attemptBindingDigest: String(identityPart.attempt_binding_digest),
        plannedDigest: String(plannedPart.planned_digest),
        finalRequestDigest: "a".repeat(64),
        idempotencyKey: "qa-admission-key",
      },
      "qa-proof",
    );
    e.authorization_observation = {
      state: "granted",
      request_ref: "request-example",
      admission_ref: admitted.admissionId,
    };
    update();
    service = new ModelAttemptSettlementService(
      tx,
      app.get(CommandReceiptRepository),
      audit,
      effects,
      app.get(MeteringService),
      admissions,
      {
        read: (input) => {
          tx.assertNoActiveTransaction();
          if (!online) throw new Error("isolated peer offline");
          reads++;
          return Promise.resolve(
            bindSealedAgentUsageEvidence(Buffer.from(head), input.expected),
          );
        },
      },
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await db?.close();
  });
  test("real usage captures one integer credit and releases nine", async () => {
    const result = await service.settle(context(), command());
    expect(result).toMatchObject({
      status: "captured",
      runId: e.identity.run_id,
      attemptId: e.identity.attempt_id,
      capturedMicros: "1000000",
      releasedMicros: "9000000",
    });
    expect(await balances()).toEqual({ available: 99_000_000n, held: 0n });
    expect(await db.client.billing_usage_settlement.count()).toBe(1);
    expect(
      await db.client.billing_usage_event.findFirstOrThrow(),
    ).toMatchObject({ quantity: 2n, status: "settled" });
    expect(
      (await admissions.read(context(), admitted.admissionId))?.status,
    ).toBe("captured");
    online = false;
    const before = await facts();
    expect(await service.settle(context(), command())).toEqual(result);
    expect(await facts()).toEqual(before);
    const row = await db.client.billing_admission.findFirstOrThrow();
    await withHttp(async (http) => {
      const result = await http.inject({
        method: "POST",
        url: "/v1/internal/billing/admissions/recover",
        headers: { ...headers(), "idempotency-key": "qa-admission-key" },
        payload: {
          run_id: row.run_id,
          attempt_id: row.attempt_id,
          request_ref: row.request_ref,
          attempt_binding_digest: row.attempt_binding_digest,
          planned_digest: row.planned_digest,
          final_request_digest: row.final_request_digest,
        },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        data: {
          admission_id: admitted.admissionId,
          status: "held",
          budget_credits: "10",
          created_at: admitted.createdAt,
          updated_at: admitted.createdAt,
        },
      });
    });
    expect(await facts()).toEqual(before);
    expect(reads).toBe(1);
  });
  test("wrong Run is rejected before receipt recovery, peer access or writes", async () => {
    await service.settle(context(), command());
    online = false;
    const before = await facts();
    await expect(
      service.settle(context(), {
        ...command("foreign-run-key"),
        runId: "different-run",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await facts()).toEqual(before);
    expect(reads).toBe(1);
  });
  test("parallel duplicate and new key recover one charge", async () => {
    const [a, b] = await Promise.all([
      service.settle(context(), command()),
      service.settle(context(), command("second-settlement-key")),
    ]);
    expect(a).toEqual(b);
    expect(await balances()).toEqual({ available: 99_000_000n, held: 0n });
    expect(await db.client.billing_usage_settlement.count()).toBe(1);
  });
  test.each(["failed", "cancelled"] as const)(
    "known actual for %s is not free",
    async (outcome) => {
      e.execution.outcome = outcome;
      update();
      expect(await service.settle(context(), command())).toMatchObject({
        status: "captured",
        capturedMicros: "1000000",
      });
    },
  );
  test("unknown keeps full hold and adjacent known successor settles once", async () => {
    const known = structuredClone(e);
    e.execution.outcome = "unknown";
    e.actual = { state: "unknown", reason: "not_observed" };
    e.usage = {
      state: "unresolved",
      reason: "missing_usage",
      raw_usage_digest: null,
    };
    update();
    const original = command(),
      previous = structuredClone(e);
    const pending = await service.settle(context(), original);
    expect(pending).toMatchObject({
      status: "pending_reconciliation",
      capturedMicros: "0",
      releasedMicros: "0",
    });
    expect(await balances()).toEqual({
      available: 90_000_000n,
      held: 10_000_000n,
    });
    expect(await db.client.billing_usage_settlement.count()).toBe(0);
    e = known;
    e.identity.event_id = randomUUID();
    e.revision = "2";
    e.predecessor = {
      event_id: previous.identity.event_id,
      digest: previous.digest,
    };
    e.observed_at = "2026-10-22T00:00:00.000Z";
    update();
    expect(
      await service.settle(context(), command("known-successor-key")),
    ).toMatchObject({ status: "captured", capturedMicros: "1000000" });
    online = false;
    expect(await service.settle(context(), original)).toEqual(pending);
    expect(await balances()).toEqual({ available: 99_000_000n, held: 0n });
  });
  test.each(["tenant", "actor"])(
    "foreign %s is rejected before reading the evidence",
    async (kind) => {
      const before = await facts();
      await expect(
        service.settle(
          {
            ...context(),
            ...(kind === "tenant"
              ? { tenantId: "foreign" }
              : { actorId: "foreign" }),
          },
          command(),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await facts()).toEqual(before);
      expect(reads).toBe(0);
    },
  );
  test("same event cannot change metadata even with a new key and offline Agent", async () => {
    await service.settle(context(), command());
    online = false;
    const before = await facts();
    await expect(
      service.settle(context(), {
        ...command("altered-command-key"),
        digest: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await facts()).toEqual(before);
    expect(reads).toBe(1);
  });
  test.each([
    "skipped_revision",
    "wrong_predecessor",
    "missing_receipt",
    "missing_predecessor_receipt",
  ])("pending %s is rejected atomically", async (kind) => {
    e.execution.outcome = "unknown";
    update();
    await service.settle(context(), command());
    if (kind === "missing_receipt" || kind === "missing_predecessor_receipt") {
      const r = await db.client.billing_command_receipt.findFirstOrThrow({
        where: { command_name: "model.settle" },
      });
      await db.client.billing_command_key_binding.deleteMany({
        where: { command_receipt_id: r.id },
      });
      await db.client.billing_command_receipt.delete({ where: { id: r.id } });
    }
    if (kind !== "missing_receipt") {
      const previous = structuredClone(e);
      e.identity.event_id = randomUUID();
      e.revision = kind === "skipped_revision" ? "3" : "2";
      e.predecessor = {
        event_id: previous.identity.event_id,
        digest: kind === "wrong_predecessor" ? "a".repeat(64) : previous.digest,
      };
      e.observed_at = "2026-10-22T00:00:00.000Z";
      update();
    }
    const before = await facts();
    await expect(
      service.settle(context(), command("pending-invalid-key")),
    ).rejects.toMatchObject({
      code: kind.startsWith("missing_") ? "CORRUPT" : "CONFLICT",
    });
    expect(await facts()).toEqual(before);
  });
  test("terminal state refuses a later evidence head even if the peer provides it", async () => {
    await service.settle(context(), command());
    const prior = structuredClone(e);
    e.identity.event_id = randomUUID();
    e.revision = "2";
    e.predecessor = { event_id: prior.identity.event_id, digest: prior.digest };
    e.observed_at = "2026-10-22T00:00:00.000Z";
    update();
    const before = await facts();
    await expect(
      service.settle(context(), command("late-terminal-key")),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await facts()).toEqual(before);
  });
  test("known zero has real usage settlement, distinct from unknown or no-dispatch", async () => {
    if (e.usage.state !== "normalized") throw new Error();
    for (const k of ["input_total", "output_total", "total"] as const)
      e.usage.value[k] = { state: "reported", count: "0" };
    e.usage.value.totals_state = "known_zero";
    update();
    expect(await service.settle(context(), command())).toMatchObject({
      status: "captured",
      capturedMicros: "0",
      releasedMicros: "10000000",
    });
    expect(await balances()).toEqual({ available: 100_000_000n, held: 0n });
    expect(
      await db.client.billing_usage_event.findFirstOrThrow(),
    ).toMatchObject({ quantity: 0n, status: "settled" });
  });
  test.each(["two-root", "legacy-cache"] as const)(
    "%s tariff with missing cache preserves its own charging semantics and replay",
    async (tariff) => {
      const originalAdmission =
        await db.client.billing_admission.findFirstOrThrow();
      const original = frozenPricingFixture();
      const publisher = app.get(MeteringPricingPublicationService);
      const metadata = {
        schemaVersion: "2" as const,
        tenantId: "qa-tenant",
        effectiveFrom: "2026-01-02T00:00:00.000Z",
        sourceRef: "synthetic tariff regression",
        verifiedAt: "2026-01-02T00:00:00.000Z",
        profileRef: original.profileRef,
      };
      const publication = {
        tenantId: "qa-tenant",
        actorId: "qa-admin",
        publicationIdentity: "tariff-rate",
        idempotencyKey: "tariff-rate-key",
        reason: "isolated two-root and historical cache tariff regression",
      };
      const adminContext = {
        tenantId: "qa-tenant",
        operatorId: "qa-admin",
        role: "billing.admin",
      };
      await publisher.publishRate(adminContext, {
        ...publication,
        draft: {
          ...metadata,
          rates:
            tariff === "two-root"
              ? original.rates
              : [
                  ...original.rates,
                  {
                    ...assertDefined(original.rates[0]),
                    bucket: "input_cache_read",
                  },
                ],
        },
      });
      await publisher.publishPolicy(adminContext, {
        ...publication,
        publicationIdentity: "tariff-policy",
        idempotencyKey: "tariff-policy-key",
        draft: {
          ...metadata,
          currencyCode: original.currencyCode,
          multiplier:
            tariff === "two-root"
              ? { numerator: "3", denominator: "2" }
              : original.policy.multiplier,
          creditMicrosPerMinor: original.policy.creditMicrosPerMinor,
          maxAttemptCredits: "10",
          roundingVersion: "attempt-credit-ceil-v2",
          failurePolicyRef: original.policy.failurePolicyRef,
        },
      });
      e.identity.attempt_id = randomUUID();
      e.identity.event_id = randomUUID();
      const { event_id: _event, ...identity } = e.identity;
      void _event;
      admitted = await admissions.create(
        context(),
        {
          runId: e.identity.run_id,
          attemptId: e.identity.attempt_id,
          requestRef: "next-request",
          attemptBindingDigest: createHash("sha256")
            .update(canonicalFixture(identity))
            .digest("hex"),
          plannedDigest: createHash("sha256")
            .update(canonicalFixture(e.planned))
            .digest("hex"),
          finalRequestDigest: "a".repeat(64),
          idempotencyKey: "tariff-admission-key",
        },
        "qa-proof",
      );
      e.authorization_observation = {
        state: "granted",
        request_ref: "next-request",
        admission_ref: admitted.admissionId,
      };
      if (e.usage.state !== "normalized") throw new Error();
      Object.assign(e.usage.value, {
        input_total: { state: "reported", count: "5" },
        output_total: { state: "reported", count: "2" },
        total: { state: "reported", count: "7" },
        input_cache_read: { state: "unreported" },
        input_cache_write: { state: "unreported" },
        output_reasoning: { state: "unreported" },
      });
      update();
      const captured = tariff === "two-root";
      const result = await service.settle(context(), command());
      expect(result).toMatchObject({
        status: captured ? "captured" : "pending_reconciliation",
        reason: captured ? null : "unknown_usage_or_outcome",
        capturedMicros: captured ? "2000000" : "0",
        releasedMicros: captured ? "8000000" : "0",
      });
      expect(await balances()).toEqual({
        available: captured ? 88_000_000n : 80_000_000n,
        held: captured ? 10_000_000n : 20_000_000n,
      });
      expect(await db.client.billing_usage_settlement.count()).toBe(
        captured ? 1 : 0,
      );
      expect(
        await db.client.billing_admission.findUniqueOrThrow({
          where: { id: originalAdmission.id },
        }),
      ).toEqual(originalAdmission);
      online = false;
      const settledFacts = await facts();
      expect(await service.settle(context(), command())).toEqual(result);
      expect(await facts()).toEqual(settledFacts);
      expect(reads).toBe(1);
    },
  );
  test("new 3/2 publication preserves an old snapshot multiplier, rounding and exact replay", async () => {
    const original = frozenPricingFixture();
    const admissionBefore =
      await db.client.billing_admission.findFirstOrThrow();
    if (e.usage.state !== "normalized") throw new Error();
    Object.assign(e.usage.value, {
      input_total: { state: "reported", count: "5" },
      output_total: { state: "reported", count: "2" },
      total: { state: "reported", count: "7" },
    });
    update();
    await app.get(MeteringPricingPublicationService).publishRate(
      { tenantId: "qa-tenant", operatorId: "qa-admin", role: "billing.admin" },
      {
        tenantId: "qa-tenant",
        actorId: "qa-admin",
        publicationIdentity: "new-price",
        idempotencyKey: "new-price-key",
        reason: "synthetic price update",
        draft: {
          schemaVersion: "2",
          tenantId: "qa-tenant",
          effectiveFrom: "2026-10-22T00:00:00.000Z",
          sourceRef: "new QA",
          verifiedAt: "2026-10-22T00:00:00.000Z",
          profileRef: original.profileRef,
          rates: original.rates.map((r) => ({
            ...r,
            minorPerUnit: { numerator: "100", denominator: "1" },
          })),
        },
      },
    );
    await app.get(MeteringPricingPublicationService).publishPolicy(
      { tenantId: "qa-tenant", operatorId: "qa-admin", role: "billing.admin" },
      {
        tenantId: "qa-tenant",
        actorId: "qa-admin",
        publicationIdentity: "new-policy",
        idempotencyKey: "new-policy-key",
        reason: "synthetic 3/2 policy update",
        draft: {
          schemaVersion: "2",
          tenantId: "qa-tenant",
          effectiveFrom: "2026-10-22T00:00:00.000Z",
          sourceRef: "new QA policy",
          verifiedAt: "2026-10-22T00:00:00.000Z",
          profileRef: original.profileRef,
          currencyCode: original.currencyCode,
          multiplier: { numerator: "3", denominator: "2" },
          creditMicrosPerMinor: original.policy.creditMicrosPerMinor,
          maxAttemptCredits: "10",
          roundingVersion: "attempt-credit-ceil-v2",
          failurePolicyRef: original.policy.failurePolicyRef,
        },
      },
    );
    // Old 7/5: 0.7 × 7/5 = 0.98, ceil once to 1; 3/2 would charge 2.
    const result = await service.settle(context(), command());
    expect(result).toMatchObject({
      status: "captured",
      capturedMicros: "1000000",
      releasedMicros: "9000000",
    });
    const admissionAfter = await db.client.billing_admission.findFirstOrThrow();
    expect(admissionAfter.pricing_snapshot_json).toBe(
      admissionBefore.pricing_snapshot_json,
    );
    expect(admissionAfter.pricing_snapshot_digest).toBe(
      admissionBefore.pricing_snapshot_digest,
    );
    expect(JSON.parse(admissionAfter.pricing_snapshot_json)).toMatchObject({
      policy: {
        multiplier: { numerator: "7", denominator: "5" },
        roundingVersion: "attempt-credit-ceil-v2",
        maxAttemptCredits: "10",
      },
    });
    online = false;
    const settledFacts = await facts();
    expect(await service.settle(context(), command())).toEqual(result);
    expect(await facts()).toEqual(settledFacts);
    expect(await db.client.billing_usage_settlement.count()).toBe(1);
    expect(reads).toBe(1);
  });
  test("pending ACK racing an adjacent settlement recovers its original result", async () => {
    const known = structuredClone(e);
    e.execution.outcome = "unknown";
    e.actual = { state: "unknown", reason: "not_observed" };
    e.usage = {
      state: "unresolved",
      reason: "missing_usage",
      raw_usage_digest: null,
    };
    update();
    const original = command(),
      pending = await service.settle(context(), original),
      previous = structuredClone(e);
    e = known;
    e.identity.event_id = randomUUID();
    e.revision = "2";
    e.predecessor = {
      event_id: previous.identity.event_id,
      digest: previous.digest,
    };
    e.observed_at = "2026-10-22T00:00:00.000Z";
    update();
    const [settled, ...replayed] = await Promise.all([
      service.settle(context(), command("adjacent-racing-key")),
      ...Array.from({ length: 4 }, () => service.settle(context(), original)),
    ]);
    expect(settled).toMatchObject({
      status: "captured",
      capturedMicros: "1000000",
    });
    for (const value of replayed) expect(value).toEqual(pending);
    expect(await balances()).toEqual({ available: 99_000_000n, held: 0n });
    expect(await db.client.billing_usage_settlement.count()).toBe(1);
  });
  test("tampered permanent amount is rejected without reading the peer", async () => {
    const result = await service.settle(context(), command());
    online = false;
    const receipt = await db.client.billing_command_receipt.findFirstOrThrow({
      where: { command_name: "model.settle" },
    });
    await db.client.billing_command_receipt.update({
      where: { id: receipt.id },
      data: { result_json: { ...result, capturedMicros: "2000000" } },
    });
    const before = await facts();
    await expect(service.settle(context(), command())).rejects.toMatchObject({
      code: "CORRUPT",
    });
    expect(await facts()).toEqual(before);
    expect(reads).toBe(1);
  });
  test.each(["provider", "model", "commercial_refs", "raw_model_name"])(
    "verified %s outside frozen actual coverage keeps money pending",
    async (kind) => {
      if (e.actual.state !== "verified") throw new Error();
      if (kind === "provider") e.actual.provider_ref = "other-provider";
      if (kind === "model") e.actual.model_ref = "other-model";
      if (kind === "commercial_refs") {
        e.actual.provider_ref = "qa-provider";
        e.actual.model_ref = "qa-model";
      }
      if (kind === "raw_model_name")
        e.actual.model_ref = e.planned.provider_model_name;
      update();
      expect(await service.settle(context(), command())).toMatchObject({
        status: "pending_reconciliation",
        reason: "unknown_usage_or_outcome",
        capturedMicros: "0",
        releasedMicros: "0",
      });
      expect(await balances()).toEqual({
        available: 90_000_000n,
        held: 10_000_000n,
      });
      expect(await db.client.billing_usage_settlement.count()).toBe(0);
      expect(await db.client.billing_usage_event.count()).toBe(0);
    },
  );
  test("over budget preserves hold and never clamps or adds debit", async () => {
    if (e.usage.state !== "normalized") throw new Error();
    e.usage.value.input_total = { state: "reported", count: "1000" };
    e.usage.value.total = { state: "reported", count: "1001" };
    update();
    expect(await service.settle(context(), command())).toMatchObject({
      status: "pending_reconciliation",
      reason: "budget_exceeded",
    });
    expect(await balances()).toEqual({
      available: 90_000_000n,
      held: 10_000_000n,
    });
    expect(await db.client.billing_usage_settlement.count()).toBe(0);
  });
  test("valid huge usage stays pending and blocks the Run's next admission", async () => {
    if (e.usage.state !== "normalized") throw new Error();
    e.usage.value.input_total = {
      state: "reported",
      count: "9223372036854775806",
    };
    e.usage.value.total = { state: "reported", count: "9223372036854775807" };
    update();
    expect(await service.settle(context(), command())).toMatchObject({
      status: "pending_reconciliation",
      reason: "budget_exceeded",
    });
    expect(await balances()).toEqual({
      available: 90_000_000n,
      held: 10_000_000n,
    });
    expect(await db.client.billing_usage_settlement.count()).toBe(0);
    const before = await facts();
    const { event_id: _event, ...identity } = e.identity;
    void _event;
    // New attempt binding is provided by the same named strict Agent port fixture.
    e.identity.attempt_id = randomUUID();
    identity.attempt_id = e.identity.attempt_id;
    await expect(
      admissions.create(
        context(),
        {
          runId: e.identity.run_id,
          attemptId: e.identity.attempt_id,
          requestRef: "next-request",
          attemptBindingDigest: createHash("sha256")
            .update(canonicalFixture(identity))
            .digest("hex"),
          plannedDigest: createHash("sha256")
            .update(canonicalFixture(e.planned))
            .digest("hex"),
          finalRequestDigest: "a".repeat(64),
          idempotencyKey: "next-admission-key",
        },
        "qa-proof",
      ),
    ).rejects.toMatchObject({ code: "RUN_BLOCKED" });
    expect(await facts()).toEqual(before);
  });
  test.each([
    "terminal_source",
    "usage_source",
    "usage_quantity",
    "usage_dimensions",
    "admission_head",
  ])(
    "terminal receipt refuses corrupted %s without peer reads or new money",
    async (kind) => {
      const result = await service.settle(context(), command());
      online = false;
      if (kind === "terminal_source")
        await db.client.billing_credit_hold.update({
          where: { id: admitted.holdId },
          data: { terminal_source_ref: "foreign-usage" },
        });
      if (kind === "usage_source")
        await db.client.billing_usage_event.update({
          where: { id: assertDefined(result.usageEventId) },
          data: { source_event_id: randomUUID() },
        });
      if (kind === "usage_quantity")
        await db.client.billing_usage_event.update({
          where: { id: assertDefined(result.usageEventId) },
          data: { quantity: 3n },
        });
      if (kind === "usage_dimensions")
        await db.client.billing_usage_event.update({
          where: { id: assertDefined(result.usageEventId) },
          data: { dimensions_json: "{}" },
        });
      if (kind === "admission_head")
        await db.client.billing_admission.update({
          where: { id: admitted.admissionId },
          data: { settlement_evidence_json: null },
        });
      const before = await facts();
      await expect(service.settle(context(), command())).rejects.toMatchObject({
        code: "CORRUPT",
      });
      expect(await facts()).toEqual(before);
      expect(reads).toBe(1);
    },
  );
  test("confirmed no dispatch releases without invented usage", async () => {
    e.execution.outcome = "not_dispatched";
    e.execution.dispatch_started_at = null;
    e.actual = { state: "unknown", reason: "not_observed" };
    e.authorization_observation = {
      state: "requested_unknown",
      request_ref: "request-example",
    };
    e.usage = {
      state: "unresolved",
      reason: "missing_usage",
      raw_usage_digest: null,
    };
    update();
    expect(await service.settle(context(), command())).toMatchObject({
      status: "released",
      releasedMicros: "10000000",
    });
    expect(await balances()).toEqual({ available: 100_000_000n, held: 0n });
    expect(await db.client.billing_usage_event.count()).toBe(0);
    online = false;
    const before = await facts();
    await expect(service.settle(context(), command())).resolves.toMatchObject({
      status: "released",
    });
    expect(await facts()).toEqual(before);
    await db.client.billing_credit_hold.update({
      where: { id: admitted.holdId },
      data: { terminal_source_ref: "foreign-release" },
    });
    const corrupt = await facts();
    await expect(service.settle(context(), command())).rejects.toMatchObject({
      code: "CORRUPT",
    });
    expect(await facts()).toEqual(corrupt);
  });
  test.each(["admission", "request", "prepared"])(
    "rejects mismatched %s before monetary effects",
    async (kind) => {
      if (e.authorization_observation.state !== "granted") throw new Error();
      if (kind === "admission")
        e.authorization_observation.admission_ref = randomUUID();
      if (kind === "request")
        e.authorization_observation.request_ref = "foreign";
      if (kind === "prepared")
        e.execution.prepared_at = "2026-10-03T12:34:54.000Z";
      update();
      const before = await facts();
      await expect(service.settle(context(), command())).rejects.toMatchObject({
        code: "CORRUPT",
      });
      expect(await facts()).toEqual(before);
    },
  );
  test("formal HTTP captures integer credits and recovers the same public ACK offline", async () => {
    await withHttp(async (http) => {
      const first = await http.inject({
        method: "POST",
        url: path(),
        headers: headers(),
        payload: body(),
      });
      expect(first.statusCode, first.body).toBe(200);
      const ack = first.json<AdmissionSettlementResponse>();
      expect(ack.data).toMatchObject({
        admission_id: admitted.admissionId,
        run_id: e.identity.run_id,
        attempt_id: e.identity.attempt_id,
        status: "captured",
        captured_credits: "1",
        released_credits: "9",
        reason: null,
      });
      expect(Object.keys(ack.data).sort()).toEqual(
        [
          "admission_id",
          "run_id",
          "attempt_id",
          "evidence_event_id",
          "evidence_revision",
          "evidence_digest",
          "status",
          "reason",
          "captured_credits",
          "released_credits",
          "usage_event_id",
          "settlement_id",
          "updated_at",
        ].sort(),
      );
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(await balances()).toEqual({ available: 99_000_000n, held: 0n });
      online = false;
      const before = await facts();
      const replay = await http.inject({
        method: "POST",
        url: path(),
        headers: headers(),
        payload: body(),
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(ack);
      expect(await facts()).toEqual(before);
      expect(reads).toBe(1);
    });
  });
  test("formal pending ACK stays original after a known adjacent capture", async () => {
    e.execution.outcome = "unknown";
    update();
    const request = body(),
      previous = structuredClone(e);
    await withHttp(async (http) => {
      const pending = await http.inject({
        method: "POST",
        url: path(),
        headers: headers(),
        payload: request,
      });
      expect(pending.statusCode, pending.body).toBe(200);
      expect(pending.json<AdmissionSettlementResponse>().data).toMatchObject({
        status: "pending_reconciliation",
        captured_credits: "0",
        released_credits: "0",
        reason: "unknown_usage_or_outcome",
      });
      e.execution.outcome = "completed";
      e.identity.event_id = randomUUID();
      e.revision = "2";
      e.predecessor = {
        event_id: previous.identity.event_id,
        digest: previous.digest,
      };
      e.observed_at = "2026-10-22T00:00:00.000Z";
      update();
      const next = await http.inject({
        method: "POST",
        url: path(),
        headers: { ...headers(), "idempotency-key": "known-http-settlement" },
        payload: body(),
      });
      expect(next.statusCode, next.body).toBe(200);
      expect(next.json<AdmissionSettlementResponse>().data.status).toBe(
        "captured",
      );
      online = false;
      const before = await facts(),
        replay = await http.inject({
          method: "POST",
          url: path(),
          headers: headers(),
          payload: request,
        });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(pending.json());
      expect(await facts()).toEqual(before);
    });
  });
  test("formal HTTP releases only confirmed unused admission", async () => {
    e.execution.outcome = "not_dispatched";
    e.execution.dispatch_started_at = null;
    e.actual = { state: "unknown", reason: "not_observed" };
    e.usage = {
      state: "unresolved",
      reason: "missing_usage",
      raw_usage_digest: null,
    };
    update();
    await withHttp(async (http) => {
      const reply = await http.inject({
        method: "POST",
        url: path(),
        headers: headers(),
        payload: body(),
      });
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.json<AdmissionSettlementResponse>().data).toMatchObject({
        status: "released",
        reason: null,
        captured_credits: "0",
        released_credits: "10",
        usage_event_id: null,
        settlement_id: null,
      });
      expect(await balances()).toEqual({ available: 100_000_000n, held: 0n });
      expect(await db.client.billing_usage_event.count()).toBe(0);
    });
  });
  test("formal HTTP rejects malformed, ambiguous, oversized and caller-authoritative commands", async () => {
    await withHttp(async (http) => {
      const json = JSON.stringify(body());
      const invalid = [
        { ...body(), actual_micros: "1" },
        { ...body(), tenant_id: "qa-tenant" },
        { ...body(), status: "released" },
        { ...body(), evidence_json: head },
        { ...body(), evidence_revision: "9223372036854775808" },
        { ...body(), evidence_revision: 1 },
        null,
        [],
        json.replace('"run_id":', '"run_id":"bad","run_id":'),
        json.replace('"run_id":', String.raw`"\u0072un_id":"bad","run_id":`),
        json + "x",
        json + " ".repeat(17000),
        Buffer.from([0xc3, 0x28]),
      ];
      const before = await facts();
      for (const payload of invalid) {
        const reply = await http.inject({
          method: "POST",
          url: path(),
          headers: headers(),
          payload: payload === null ? "null" : payload,
        });
        expect(reply.statusCode, reply.body).toBe(400);
      }
      for (const patch of [
        { "x-billing-execution-proof": "qa-proof" },
        { "x-billing-consumption-token": "qa-old" },
        {
          "x-billing-execution-proof": "qa-proof",
          "x-billing-consumption-token": "qa-old",
        },
      ]) {
        const reply = await http.inject({
          method: "POST",
          url: path(),
          headers: { ...headers(), ...patch },
          payload: body(),
        });
        expect(reply.statusCode, reply.body).toBe(400);
      }
      expect(await facts()).toEqual(before);
      expect(reads).toBe(0);
    });
  });
  test("formal HTTP rejects foreign Run/actor and incomplete machine auth before peer work", async () => {
    await withHttp(async (http) => {
      const before = await facts();
      for (const key of [
        "authorization",
        "x-kokoro-internal-secret",
        "x-kokoro-service",
        "x-kokoro-tenant-id",
        "x-kokoro-subject",
      ] as const) {
        const h: Record<string, string> = { ...headers() };
        delete h[key];
        const reply = await http.inject({
          method: "POST",
          url: path(),
          headers: h,
          payload: body(),
        });
        expect(reply.statusCode, reply.body).toBe(403);
      }
      for (const [h, payload] of [
        [
          {
            ...headers(),
            "x-kokoro-subject":
              "u1." + Buffer.from("other-user").toString("base64url"),
          },
          body(),
        ],
        [headers(), { ...body(), run_id: "other-run" }],
      ] as const) {
        const reply = await http.inject({
          method: "POST",
          url: path(),
          headers: h,
          payload,
        });
        expect(reply.statusCode, reply.body).toBe(403);
      }
      expect(await facts()).toEqual(before);
      expect(reads).toBe(0);
    });
  });
  test("real TCP duplicate critical headers and encoded route aliases are rejected without effects", async () => {
    e.execution.outcome = "unknown";
    update();
    let before = await facts();
    await withHttp(async (http) => {
      await http.listen(0, "127.0.0.1");
      const base = await http.getUrl();
      const payload = JSON.stringify(body());
      const rawHeaders = () => [
        "host",
        new URL(base).host,
        "content-length",
        String(Buffer.byteLength(payload)),
        ...Object.entries(headers()).flat(),
      ];
      const send = (raw: string[]) =>
        new Promise<number | undefined>((resolve, reject) => {
          const request = httpRequest(
            base + path(),
            { method: "POST", headers: raw },
            (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode));
              response.once("error", reject);
            },
          );
          request.setTimeout(2000, () =>
            request.destroy(new Error("Owned TCP request deadline")),
          );
          request.once("error", reject);
          request.end(payload);
        });
      // A successful identical raw frame proves the negatives are not merely malformed HTTP.
      expect(await send(rawHeaders())).toBe(200);
      expect(await balances()).toEqual({
        available: 90_000_000n,
        held: 10_000_000n,
      });
      before = await facts();
      for (const name of [
        "authorization",
        "x-kokoro-internal-secret",
        "x-kokoro-service",
        "x-kokoro-tenant-id",
        "x-kokoro-subject",
        "idempotency-key",
        "content-type",
      ] as const) {
        const raw = rawHeaders();
        raw.push(name, headers()[name]);
        expect([400, 403]).toContain(await send(raw));
      }
      const id = admitted.admissionId;
      for (const alias of [
        path().replace(id, `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`),
        path().replace(id, id.toUpperCase()),
      ]) {
        const reply = await http.inject({
          method: "POST",
          url: alias,
          headers: headers(),
          payload: body(),
        });
        expect([400, 404]).toContain(reply.statusCode);
      }
    });
    expect(await facts()).toEqual(before);
    expect(reads).toBe(1);
  });
  test("formal HTTP deadline rolls back without clearing an unknown attempt", async () => {
    const before = await facts();
    await withHttp(
      async (http) => {
        const reply = await http.inject({
          method: "POST",
          url: path(),
          headers: headers(),
          payload: body(),
        });
        expect(reply.statusCode, reply.body).toBe(503);
      },
      true,
      1,
    );
    expect(await facts()).toEqual(before);
  });
  test("disabled or retired command routes never settle money", async () => {
    const before = await facts();
    await withHttp(async (http) => {
      const reply = await http.inject({
        method: "POST",
        url: path(),
        headers: headers(),
        payload: body(),
      });
      expect(reply.statusCode, reply.body).toBe(404);
    }, false);
    await withHttp(async (http) => {
      for (const suffix of ["capture", "release"]) {
        const reply = await http.inject({
          method: "POST",
          url: path().replace(/settle$/u, suffix),
          headers: headers(),
          payload: body(),
        });
        expect(reply.statusCode, reply.body).toBe(404);
      }
      for (const suffix of ["?ignored=1", "/"]) {
        const reply = await http.inject({
          method: "POST",
          url: path() + suffix,
          headers: headers(),
          payload: body(),
        });
        expect([400, 404]).toContain(reply.statusCode);
      }
    });
    expect(await facts()).toEqual(before);
    expect(reads).toBe(0);
  });
  test("audit cancellation rolls evidence, money and receipt back", async () => {
    const abort = new AbortController(),
      original = audit.append.bind(audit);
    vi.spyOn(audit, "append").mockImplementation(async (input) => {
      const value = await original(input);
      if (input.action === "model.settle") abort.abort();
      return value;
    });
    const before = await facts();
    await expect(
      service.settle({ ...context(), signal: abort.signal }, command()),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(await facts()).toEqual(before);
  });
});
