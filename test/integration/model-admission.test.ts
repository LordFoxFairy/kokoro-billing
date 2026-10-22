import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { AuditAppender } from "../../src/database/audit-appender.js";
import {
  CreditService,
  CreditEffects,
} from "../../src/modules/credit/credit.public.js";
import { MeteringModule } from "../../src/modules/metering/metering.module.js";
import { MeteringPricingPublicationService } from "../../src/modules/metering/metering-pricing-publication.service.js";
import { MeteringPricingSelectionService } from "../../src/modules/metering/metering-pricing-selection.service.js";
import { AgentUsageEvidenceReader } from "../../src/modules/metering/agent-usage-evidence-reader.js";
import { IamBillingAuthorizationClient } from "../../src/modules/metering/iam-billing-authorization.client.js";
import { resolveIamBillingAuthorizationOptions } from "../../src/modules/metering/iam-billing-authorization.options.js";
import { canonicalAgentUsageJson } from "../../src/modules/metering/agent-usage-json.js";
import { ModelAdmissionService } from "../../src/modules/metering/model-admission.service.js";
import type { ModelAdmissionCommand } from "../../src/modules/metering/model-admission.types.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";
const admin = process.env.SCHEMA_ADMIN_URL;
const tenantId = "tenant-admission",
  actorId = "user-admission";
const profileRef = {
  version: "2.0.0",
  artifactDigest:
    "7c5fd0b24d0a691cfcf769a981d8b4a8a689534d9b4ae1b5968342bde591094c",
};
const modelRevision = {
  id: "11111111-1111-4111-8111-111111111111",
  contentDigest: "a".repeat(64),
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
describe.skipIf(admin === undefined)(
  "first actual model budget reservation and durable recovery",
  () => {
    let fixture: PrismaDatabaseFixture | undefined,
      app: TestingModule | undefined,
      server: Server | undefined,
      reader: AgentUsageEvidenceReader,
      iam: IamBillingAuthorizationClient;
    let service: ModelAdmissionService,
      tx: TransactionService,
      credit: CreditService;
    let agentCalls: number,
      iamCalls: number,
      peerEnabled: boolean,
      grantUser: string,
      expiry: string;
    let authorizationExpiry: string;
    let makeReply: (requestId: string) => object;
    const context = () => ({
      tenantId,
      actorId,
      requestId: "admission-request",
      signal: new AbortController().signal,
    });
    const command = (
      runId = "run-admission",
      attemptId = randomUUID(),
      requestRef = `request-${attemptId}`,
    ): ModelAdmissionCommand => {
      const identity = {
        tenant_ref: tenantId,
        actor: { kind: "user", opaque_ref: actorId },
        subject: { kind: "user", opaque_ref: actorId },
        identity_assertion_ref: "qa-assertion",
        run_id: runId,
        session_id: "qa-session",
        call_id: randomUUID(),
        attempt_id: attemptId,
        attempt_ordinal: "1",
        lease: { owner: "qa-worker", generation: "1" },
        input_digest: "c".repeat(64),
        peer_path: ["assistant"],
      };
      const planned = {
        binding_version: "2.0.0",
        model: "qa-model",
        provider: "qa-provider",
        revision_id: modelRevision.id,
        provider_model_name: "qa-model",
        request_model: "qa-model",
        feature_key: "chat",
        revision: "1",
        generation: "1",
        tenant_generation: "1",
        digest: modelRevision.contentDigest,
        label: null,
      };
      const authorization = {
        state: "requested_unknown",
        request_ref: requestRef,
      };
      const part = (
        key: string,
        value: Parameters<typeof canonicalAgentUsageJson>[0],
      ) => {
        const raw = canonicalAgentUsageJson(value);
        return {
          [`${key}_bytes_base64url`]: Buffer.from(raw).toString("base64url"),
          [`${key}_digest`]: sha(raw),
        };
      };
      const identityPart = part("attempt_binding", identity),
        plannedPart = part("planned", planned);
      makeReply = (requestId) => ({
        data: {
          binding_version: "2.0.0",
          attempt_id: attemptId,
          status: "authorization_pending",
          ...identityPart,
          ...plannedPart,
          ...part("authorization", authorization),
          final_request_binding_version: 1,
          final_request_digest: "d".repeat(64),
          prepared_at: new Date(Date.now() - 1000).toISOString(),
          observed_at: new Date().toISOString(),
          lease_expires_at: expiry,
        },
        meta: { request_id: requestId },
      });
      // Agent HTTP request ID lives in the response header; the envelope uses its published form.
      return {
        runId,
        attemptId,
        requestRef: authorization.request_ref,
        attemptBindingDigest: String(identityPart.attempt_binding_digest),
        plannedDigest: String(plannedPart.planned_digest),
        finalRequestDigest: "d".repeat(64),
        idempotencyKey: `admit-${attemptId}`,
      };
    };
    beforeEach(async () => {
      fixture = await createPrismaDatabaseFixture(assertDefined(admin));
      app = await Test.createTestingModule({
        imports: [
          DatabaseModule.register({ databaseUrl: fixture.url }),
          MeteringModule,
        ],
      }).compile();
      await app.init();
      tx = app.get(TransactionService);
      credit = app.get(CreditService);
      agentCalls = 0;
      iamCalls = 0;
      peerEnabled = true;
      grantUser = actorId;
      expiry = new Date(Date.now() + 60000).toISOString();
      authorizationExpiry = expiry;
      server = createServer((request, response) => {
        if (!peerEnabled) {
          response.writeHead(503);
          response.end();
          return;
        }
        if (request.method === "GET") {
          agentCalls++;
          const body = makeReply(String(request.headers["x-request-id"]));
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-request-id": String(request.headers["x-request-id"]),
          });
          response.end(JSON.stringify(body));
        } else {
          iamCalls++;
          request.resume();
          request.on("end", () => {
            response.writeHead(200, {
              "content-type": "application/json",
              "x-request-id": "iam-fixture",
            });
            response.end(
              JSON.stringify({
                data: {
                  allowed: true,
                  tenant_id: tenantId,
                  user_id: grantUser,
                  session_id: "qa-session",
                  client_id: "qa-client",
                  expires_at: authorizationExpiry,
                  decision_ref: "qa-decision",
                },
              }),
            );
          });
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      reader = new AgentUsageEvidenceReader({
        baseUrl,
        machineBearerToken: "reader-fixture",
        deadlineMs: 2000,
      });
      iam = new IamBillingAuthorizationClient(
        resolveIamBillingAuthorizationOptions({
          baseUrl,
          machineBearerToken: "iam-fixture",
          deadlineMs: 2000,
        }),
      );
      service = new ModelAdmissionService(
        tx,
        app.get(CommandReceiptRepository),
        app.get(AuditAppender),
        app.get(CreditEffects),
        app.get(MeteringPricingSelectionService),
        {
          readPrepared: (input) => {
            tx.assertNoActiveTransaction();
            return reader.readPrepared(input);
          },
        },
        {
          authorize: (input) => {
            tx.assertNoActiveTransaction();
            return iam.authorize(input);
          },
        },
      );
      const publisher = app.get(MeteringPricingPublicationService);
      const common = {
        schemaVersion: "2" as const,
        tenantId,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        sourceRef: "QA explicit; not production price",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        profileRef,
      };
      const publication = {
        tenantId,
        actorId: "qa-admin",
        publicationIdentity: "qa-rate",
        idempotencyKey: "qa-rate-key",
        reason: "QA synthetic configuration",
      };
      const adminContext = {
        tenantId,
        operatorId: "qa-admin",
        role: "billing.admin",
      };
      await publisher.publishRate(adminContext, {
        ...publication,
        draft: {
          ...common,
          rates: [
            {
              modelRevision,
              providerRef: "qa-provider",
              environment: "qa",
              pricingAccountRef: "qa-account",
              modelRef: "qa-model",
              modelVersion: "qa-v1",
              bucket: "input",
              unit: "token",
              applicability: { kind: "all" },
              currencyCode: "USD",
              minorPerUnit: { numerator: "1", denominator: "1" },
            },
          ],
        },
      });
      await publisher.publishPolicy(adminContext, {
        ...publication,
        publicationIdentity: "qa-policy",
        idempotencyKey: "qa-policy-key",
        draft: {
          ...common,
          currencyCode: "USD",
          maxAttemptCredits: "10",
          multiplier: { numerator: "7", denominator: "5" },
          creditMicrosPerMinor: { numerator: "100", denominator: "1" },
          roundingVersion: "attempt-credit-ceil-v2",
          failurePolicyRef: {
            version: "1.0.0",
            artifactDigest:
              "8d8dbe5950cfaa7f1383f847ad6e270c62bbd67bf02ea8717ac8d360594cb076",
          },
        },
      });
      await credit.grant({
        tenantId,
        actorId: "qa-admin",
        subjectId: actorId,
        amountMicros: 100_000_000n,
        sourceKind: "admin_credit",
        sourceRef: "qa-funding",
        programKey: "qa",
        reason: "QA isolated funding",
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        idempotencyKey: "qa-funding-key",
      });
    });
    afterEach(async () => {
      await reader?.onModuleDestroy();
      await iam?.onModuleDestroy();
      await app?.close();
      app = undefined;
      if (server) {
        await new Promise<void>((resolve, reject) =>
          server?.close((e) => (e ? reject(e) : resolve())),
        );
        server = undefined;
      }
      await fixture?.close();
      fixture = undefined;
    });
    const create = (input: ModelAdmissionCommand) =>
      service.create(context(), input, "user-consumption-canary");
    const funds = async () => {
      const f = assertDefined(fixture);
      return {
        account: await f.client.billing_credit_account.findFirstOrThrow(),
        holds: await f.client.billing_credit_hold.findMany(),
        admissions: await f.client.billing_admission.findMany(),
        journals: await f.client.billing_credit_journal.count(),
      };
    };
    test("atomically holds the configured integer budget without a wall-clock release and freezes the exact tariff", async () => {
      const input = command();
      const result = await create(input);
      expect(result).toMatchObject({
        tenantId,
        runId: input.runId,
        attemptId: input.attemptId,
        budgetCredits: "10",
      });
      const state = await funds();
      expect(state.holds).toHaveLength(1);
      expect(state.admissions).toHaveLength(1);
      expect(state.holds[0]).toMatchObject({
        expires_at: null,
        requested_micros: 10_000_000n,
        status: "active",
      });
      expect(state.account).toMatchObject({
        available_micros: 90_000_000n,
        held_micros: 10_000_000n,
      });
      expect(state.journals).toBe(1);
      expect(agentCalls).toBe(1);
      expect(iamCalls).toBe(1);
      expect(
        JSON.stringify(state, (_, v: unknown) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ).not.toContain("user-consumption-canary");
    });
    test("lost ACK recovery and replacement keys return the original reservation with both peers offline", async () => {
      const input = command();
      const original = await create(input);
      peerEnabled = false;
      const before = await funds();
      expect(await service.create(context(), input, "expired-token")).toEqual(
        original,
      );
      expect(
        await service.create(
          context(),
          { ...input, idempotencyKey: "replacement-key" },
          "expired-token",
        ),
      ).toEqual(original);
      expect(await funds()).toEqual(before);
      expect(agentCalls).toBe(1);
      expect(iamCalls).toBe(1);
      await expect(
        service.create(
          context(),
          { ...input, finalRequestDigest: "f".repeat(64) },
          "expired-token",
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
    test("concurrent different keys create only one hold and one admission", async () => {
      const input = command();
      const results = await Promise.all([
        create(input),
        create({ ...input, idempotencyKey: "second-key" }),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect((await funds()).holds).toHaveLength(1);
    });
    test("payer mismatch and cross-tenant contexts have no financial effect", async () => {
      const input = command();
      const before = await funds();
      grantUser = "wrong-payer";
      await expect(create(input)).rejects.toBeDefined();
      expect(await funds()).toEqual(before);
      await expect(
        service.create(
          { ...context(), tenantId: "foreign" },
          input,
          "user-consumption-canary",
        ),
      ).rejects.toBeDefined();
      expect(await funds()).toEqual(before);
    });
    test("insufficient balance rolls back admission, hold and command identity", async () => {
      const input = command();
      await assertDefined(fixture).pool.query(
        "UPDATE billing_credit_account SET available_micros=0",
      );
      await expect(create(input)).rejects.toBeDefined();
      expect((await funds()).holds).toHaveLength(0);
      expect((await funds()).admissions).toHaveLength(0);
      expect(
        await assertDefined(fixture).client.billing_command_receipt.count({
          where: { command_name: "model.admit" },
        }),
      ).toBe(0);
    });
    test("audit failure rolls back all funds and the original command can recover after repair", async () => {
      const input = command();
      const f = assertDefined(fixture);
      const before = await funds();
      await f.pool.query(
        "ALTER TABLE billing_audit_event ADD CONSTRAINT qa_admission_audit_failure CHECK (action <> 'model.admit')",
      );
      await expect(create(input)).rejects.toBeDefined();
      expect(await funds()).toEqual(before);
      await f.pool.query(
        "ALTER TABLE billing_audit_event DROP CONSTRAINT qa_admission_audit_failure",
      );
      await create(input);
      expect((await funds()).holds).toHaveLength(1);
    });
    test("pending reconciliation on this Run stops a new attempt but not old receipt recovery", async () => {
      const input = command();
      const original = await create(input);
      await assertDefined(fixture).pool.query(
        "UPDATE billing_admission SET status='pending_reconciliation'",
      );
      const second = command(input.runId);
      await expect(create(second)).rejects.toMatchObject({
        code: "RUN_BLOCKED",
      });
      peerEnabled = false;
      expect(await create(input)).toEqual(original);
      expect((await funds()).holds).toHaveLength(1);
    });
    test("pre-aborted commands do not call peers or write a hold", async () => {
      const input = command();
      const controller = new AbortController();
      controller.abort();
      await expect(
        service.create(
          { ...context(), signal: controller.signal },
          input,
          "token",
        ),
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(agentCalls).toBe(0);
      expect(iamCalls).toBe(0);
      expect((await funds()).holds).toHaveLength(0);
    });
    test.each(["lease", "authorization"] as const)(
      "%s expiry while waiting for account locks rolls all reserved funds back",
      async (kind) => {
        const f = assertDefined(fixture);
        const lock = await f.pool.connect();
        const before = await funds();
        await lock.query("BEGIN");
        await lock.query("SELECT id FROM billing_credit_account FOR UPDATE");
        const boundary = new Date(Date.now() + 500).toISOString();
        if (kind === "lease") expiry = boundary;
        else authorizationExpiry = boundary;
        const input = command();
        const pending = create(input);
        const settled = pending.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        let blocked = false;
        try {
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            const observed = await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id, status, available_micros%'",
            );
            if (Number(observed.rows[0]?.n) > 0) {
              blocked = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          await new Promise((r) =>
            setTimeout(r, Math.max(0, Date.parse(boundary) - Date.now() + 25)),
          );
        } finally {
          await lock.query("ROLLBACK");
          lock.release();
        }
        const completed = await settled;
        expect(blocked).toBe(true);
        expect(completed.error).toMatchObject({ code: "EXPIRED" });
        expect(await funds()).toEqual(before);
      },
    );
    test("cancellation during account lock contention rolls back the budget rather than reporting an empty result", async () => {
      const f = assertDefined(fixture);
      const lock = await f.pool.connect();
      const before = await funds();
      const controller = new AbortController();
      const input = command();
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM billing_credit_account FOR UPDATE");
      const pending = service
        .create(
          { ...context(), signal: controller.signal },
          input,
          "user-consumption-canary",
        )
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      let blocked = false;
      try {
        const deadline = Date.now() + 800;
        while (Date.now() < deadline) {
          const observation = await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id, status, available_micros%'",
          );
          if (Number(observation.rows[0]?.n) > 0) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.abort();
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
      const completed = await pending;
      expect(blocked).toBe(true);
      expect(completed.error).toMatchObject({ code: "ABORTED" });
      expect(await funds()).toEqual(before);
    });
    test.each(["price", "authorization", "hold"] as const)(
      "corrupt durable %s rejects offline recovery without rebinding a new key",
      async (kind) => {
        const input = command();
        const original = await create(input);
        const f = assertDefined(fixture);
        peerEnabled = false;
        if (kind === "price")
          await f.pool.query(
            "UPDATE billing_admission SET pricing_snapshot_json=pricing_snapshot_json||' '",
          );
        else if (kind === "authorization")
          await f.pool.query(
            "UPDATE billing_admission SET authorization_json='{}'",
          );
        else
          await f.pool.query(
            "UPDATE billing_credit_hold SET requested_micros=requested_micros+1000000",
          );
        const keysBefore = await f.client.billing_command_key_binding.count();
        await expect(
          create({ ...input, idempotencyKey: "new-recovery-key" }),
        ).rejects.toMatchObject({ code: "CORRUPT" });
        expect(await f.client.billing_command_key_binding.count()).toBe(
          keysBefore,
        );
        expect(agentCalls).toBe(1);
        expect(iamCalls).toBe(1);
        expect(original.admissionId).toBeDefined();
      },
    );
    test("wrong current actor is rejected before IAM and never reserves the prepared user's wallet", async () => {
      const input = command();
      const before = await funds();
      await expect(
        service.create(
          { ...context(), actorId: "another-user" },
          input,
          "token",
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(iamCalls).toBe(0);
      expect(await funds()).toEqual(before);
    });
    test("ordinary timed credit holds keep their exact expiry identity and cannot replay as an unbounded model hold", async () => {
      const f = assertDefined(fixture);
      const account = await f.client.billing_credit_account.findFirstOrThrow();
      const date = new Date(Date.now() + 60000);
      const input = {
        tenantId,
        actorId,
        accountId: account.id,
        idempotencyKey: "ordinary-credit-hold",
        requestedMicros: 1000000n,
        expiresAt: date,
      };
      const first = await credit.reserve(input);
      expect(
        await credit.reserve({ ...input, expiresAt: new Date(date) }),
      ).toEqual(first);
      await expect(
        credit.reserve({ ...input, expiresAt: null }),
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
      const effects = assertDefined(app).get(CreditEffects);
      await expect(
        tx.runRoot(
          { tenantId, actorId, operation: "reserve", mode: "write" },
          () => effects.reserve({ ...input, expiresAt: null }),
        ),
      ).rejects.toMatchObject({ code: "CREDIT_IDEMPOTENCY_CONFLICT" });
      expect(
        (
          await f.client.billing_credit_hold.findUniqueOrThrow({
            where: { id: first.holdId },
          })
        ).expires_at,
      ).toEqual(date);
    });

    test.each(["cancel", "lease", "authorization"] as const)(
      "late %s during admission audit waits rolls back before COMMIT",
      async (kind) => {
        const f = assertDefined(fixture);
        const before = await funds();
        const controller = new AbortController();
        await f.pool.query(
          "CREATE FUNCTION qa_pause_model_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='model.admit' THEN PERFORM pg_advisory_xact_lock(987132); END IF; RETURN NEW; END $$",
        );
        await f.pool.query(
          "CREATE TRIGGER qa_pause_model_admission BEFORE INSERT ON billing_audit_event FOR EACH ROW EXECUTE FUNCTION qa_pause_model_admission()",
        );
        const blocker = await f.pool.connect();
        await blocker.query("SELECT pg_advisory_lock(987132)");
        const boundary = new Date(Date.now() + 500).toISOString();
        if (kind === "lease") expiry = boundary;
        if (kind === "authorization") authorizationExpiry = boundary;
        const input = command();
        const pending = service
          .create(
            { ...context(), signal: controller.signal },
            input,
            "user-consumption-canary",
          )
          .then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
        let blocked = false;
        try {
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            const r = await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=987132 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
            );
            if (Number(r.rows[0]?.n) > 0) {
              blocked = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          if (kind === "cancel") controller.abort();
          else
            await new Promise((r) =>
              setTimeout(
                r,
                Math.max(0, Date.parse(boundary) - Date.now() + 25),
              ),
            );
        } finally {
          await blocker.query("SELECT pg_advisory_unlock(987132)");
          blocker.release();
        }
        const result = await pending;
        expect(blocked).toBe(true);
        expect(result.error).toMatchObject({
          code: kind === "cancel" ? "ABORTED" : "EXPIRED",
        });
        expect(await funds()).toEqual(before);
      },
    );

    test("a different attempt cannot reuse a committed request_ref and receives a permanent conflict", async () => {
      const first = command();
      await create(first);
      const before = await funds();
      const second = command("another-run", randomUUID(), first.requestRef);
      await expect(create(second)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await funds()).toEqual(before);
      expect(
        await assertDefined(fixture).client.billing_command_receipt.count({
          where: { command_name: "model.admit" },
        }),
      ).toBe(1);
    });
  },
);
