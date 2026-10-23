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
  test("publication after admission does not reprice the frozen attempt", async () => {
    const original = frozenPricingFixture();
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
    expect(await service.settle(context(), command())).toMatchObject({
      status: "captured",
      capturedMicros: "1000000",
    });
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
