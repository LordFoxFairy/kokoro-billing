import {
  iamCredentialEntry,
  iamServiceCredentialFixture,
} from "../support/iam-service-credential.fixture.js";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { BillingHttpModule } from "../../src/http/billing-http.module.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as rawRequest, type Server } from "node:http";
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
      payerUser: string,
      expiry: string;
    let authorizationExpiry: string;
    let credential:
      Awaited<ReturnType<typeof iamServiceCredentialFixture>> | undefined;
    let waitForDisconnect = false;
    let pausePrepared: ((reply: () => void) => void) | undefined;
    let makeReply: (requestId: string) => object;
    let decisionRunId: string, decisionDigest: string;
    let decisionDelta: Record<string, unknown>, iamRequests: unknown[];
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
      decisionRunId = runId;
      decisionDigest = sha(
        JSON.stringify([
          "kokoro.billing.model-admit:1",
          tenantId,
          actorId,
          runId,
          attemptId,
          requestRef,
          String(identityPart.attempt_binding_digest),
          String(plannedPart.planned_digest),
          "d".repeat(64),
        ]),
      );
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
      iamRequests = [];
      decisionDelta = {};
      peerEnabled = true;
      payerUser = actorId;
      expiry = new Date(Date.now() + 60000).toISOString();
      authorizationExpiry = expiry;
      waitForDisconnect = false;
      pausePrepared = undefined;
      server = createServer((request, response) => {
        if (!peerEnabled) {
          response.writeHead(503);
          response.end();
          return;
        }
        if (request.method === "GET") {
          agentCalls++;
          if (waitForDisconnect) return;
          const reply = () => {
            const body = makeReply(String(request.headers["x-request-id"]));
            response.writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
              "x-request-id": String(request.headers["x-request-id"]),
            });
            response.end(JSON.stringify(body));
          };
          if (pausePrepared) pausePrepared(reply);
          else reply();
        } else {
          iamCalls++;
          let raw = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            raw += chunk;
          });
          request.on("end", () => {
            iamRequests.push(JSON.parse(raw) as unknown);
            response.writeHead(200, {
              "content-type": "application/json",
              "x-request-id": "iam-fixture",
            });
            response.end(
              JSON.stringify({
                data: {
                  allowed: true,
                  tenant_id: tenantId,
                  user_id: payerUser,
                  run_id: decisionRunId,
                  execution_session_id: "qa-session",
                  lease_generation: 1,
                  request_binding_sha256: decisionDigest,
                  expires_at: authorizationExpiry,
                  decision_ref: "qa-decision",
                  ...decisionDelta,
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
      credential = await iamServiceCredentialFixture([
        iamCredentialEntry(tenantId),
      ]);
      iam = new IamBillingAuthorizationClient(
        resolveIamBillingAuthorizationOptions({
          baseUrl,
          serviceCredentialFile: assertDefined(credential).path,
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
      await credential?.close();
      credential = undefined;
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
    const wireAuth = {
      mode: "jwks" as const,
      internalServiceSecret: "admission-test-internal-secret-000000001",
      bffServiceToken: "admission-test-bff-bearer-token-00000001",
      operatorProxySecret: "admission-test-operator-secret-000000001",
      jwksUrl: "https://iam.example.test/iam/jwks",
      issuer: "https://iam.example.test/iam",
      audience: "https://kokoro.dev/resources/billing",
    };
    const wireHeaders = (who = actorId) => ({
      authorization: `Bearer ${wireAuth.bffServiceToken}`,
      "x-kokoro-service": "web-bff",
      "x-kokoro-internal-secret": wireAuth.internalServiceSecret,
      "x-kokoro-tenant-id": "u1." + Buffer.from(tenantId).toString("base64url"),
      "x-kokoro-subject": "u1." + Buffer.from(who).toString("base64url"),
      "content-type": "application/json",
      "idempotency-key": "http-admission-key",
      "x-billing-execution-proof": "proof-fixture",
    });
    async function withHttp(
      body: (http: NestFastifyApplication) => Promise<void>,
      requestDeadlineMs = 10000,
      enabled = true,
    ) {
      const address = server?.address();
      if (!address || typeof address === "string") throw new Error();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const module = await Test.createTestingModule({
        imports: [
          DatabaseModule.register({ databaseUrl: assertDefined(fixture).url }),
          BillingHttpModule.register(
            wireAuth,
            enabled
              ? {
                  agent: {
                    baseUrl,
                    machineBearerToken: "reader-fixture",
                    deadlineMs: 2000,
                  },
                  iam: {
                    baseUrl,
                    serviceCredentialFile: assertDefined(credential).path,
                    deadlineMs: 2000,
                  },
                  requestDeadlineMs,
                }
              : undefined,
          ),
        ],
      }).compile();
      const http = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
        { logger: false },
      );
      try {
        await http.init();
        await http.getHttpAdapter().getInstance().ready();
        await body(http);
      } finally {
        await http.close();
      }
    }
    const wireCommand = (c: ModelAdmissionCommand) => ({
      run_id: c.runId,
      attempt_id: c.attemptId,
      request_ref: c.requestRef,
      attempt_binding_digest: c.attemptBindingDigest,
      planned_digest: c.plannedDigest,
      final_request_digest: c.finalRequestDigest,
    });
    const create = (input: ModelAdmissionCommand) =>
      service.create(context(), input, "run-execution-proof-canary");
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
      expect(iamRequests).toEqual([
        {
          action: "credit.consume",
          execution_proof: "run-execution-proof-canary",
          expected_request_binding_sha256: decisionDigest,
        },
      ]);
      expect(
        JSON.stringify(state.admissions, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).not.toContain("run-execution-proof-canary");
      expect(agentCalls).toBe(1);
      expect(iamCalls).toBe(1);
      expect(
        JSON.stringify(state, (_, v: unknown) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ).not.toContain("run-execution-proof-canary");
    });
    test("lost ACK recovery and replacement keys return the original reservation with both peers offline", async () => {
      const input = command();
      const original = await create(input);
      peerEnabled = false;
      const before = await funds();
      expect(await service.create(context(), input, "expired-proof")).toEqual(
        original,
      );
      expect(
        await service.create(
          context(),
          { ...input, idempotencyKey: "replacement-key" },
          "expired-proof",
        ),
      ).toEqual(original);
      expect(await funds()).toEqual(before);
      expect(agentCalls).toBe(1);
      expect(iamCalls).toBe(1);
      await expect(
        service.create(
          context(),
          { ...input, finalRequestDigest: "f".repeat(64) },
          "expired-proof",
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
    test("recover-only miss with both peers offline creates no financial or command facts", async () => {
      peerEnabled = false;
      const input = command();
      const before = await funds();
      const f = assertDefined(fixture);
      const keys = await f.client.billing_command_key_binding.count();
      const receipts = await f.client.billing_command_receipt.count();
      expect(await service.recover(context(), input)).toBeNull();
      expect(await funds()).toEqual(before);
      expect(await f.client.billing_command_key_binding.count()).toBe(keys);
      expect(await f.client.billing_command_receipt.count()).toBe(receipts);
      expect(agentCalls).toBe(0);
      expect(iamCalls).toBe(0);
    });
    test("recover-only survives peer expiry without a proof and cannot create a second reservation or repair corruption", async () => {
      const input = command();
      const original = await create(input);
      peerEnabled = false;
      const before = await funds();
      const f = assertDefined(fixture);
      const keys = await f.client.billing_command_key_binding.count();
      expect(await service.recover(context(), input)).toEqual(original);
      expect(await f.client.billing_command_key_binding.count()).toBe(keys);
      expect(
        await service.recover(context(), {
          ...input,
          idempotencyKey: "only-recovery-new-key",
        }),
      ).toEqual(original);
      expect(await f.client.billing_command_key_binding.count()).toBe(keys + 1);
      expect(await funds()).toEqual(before);
      // The existing tenant-wide command key conflicts when actor-bound payload differs; no other user's receipt is returned.
      await expect(
        service.recover({ ...context(), actorId: "other-user" }, input),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        await service.recover({ ...context(), tenantId: "foreign" }, input),
      ).toBeNull();
      await expect(
        service.recover(context(), {
          ...input,
          finalRequestDigest: "f".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(agentCalls).toBe(1);
      expect(iamCalls).toBe(1);
      await f.client.billing_admission.update({
        where: { id: original.admissionId },
        data: { pricing_snapshot_digest: "0".repeat(64) },
      });
      const afterCorrupt = await funds();
      await expect(
        service.recover(context(), {
          ...input,
          idempotencyKey: "corrupt-recovery-key",
        }),
      ).rejects.toMatchObject({ code: "CORRUPT" });
      expect(await f.client.billing_command_key_binding.count()).toBe(keys + 1);
      expect(await funds()).toEqual(afterCorrupt);
    });
    test("a recover miss before the original create enters its transaction is not a durable cancellation", async () => {
      const input = command();
      let resume: (() => void) | undefined;
      let entered: (() => void) | undefined;
      const arrived = new Promise<void>((r) => {
        entered = r;
      });
      pausePrepared = (reply) => {
        resume = reply;
        entered?.();
      };
      const before = await funds();
      const pending = create(input).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      try {
        await Promise.race([
          arrived,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("prepared peer not entered")),
              1000,
            ),
          ),
        ]);
        expect(await service.recover(context(), input)).toBeNull();
        expect(await funds()).toEqual(before);
      } finally {
        resume?.();
      }
      const created = await pending;
      expect(created.error).toBeUndefined();
      expect(created.value).toBeDefined();
      peerEnabled = false;
      expect(await service.recover(context(), input)).toEqual(created.value);
      expect((await funds()).holds).toHaveLength(1);
    });
    test("cancelling an alias recovery while its insert is blocked rolls back the alias and preserves the original funds", async () => {
      const input = command();
      await create(input);
      peerEnabled = false;
      const f = assertDefined(fixture),
        before = await funds();
      const keys = await f.client.billing_command_key_binding.count(),
        controller = new AbortController();
      await f.pool.query(
        `CREATE FUNCTION recovery_alias_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key='cancelled-recovery-key' THEN PERFORM pg_advisory_xact_lock(987145); END IF; RETURN NEW; END $$`,
      );
      await f.pool.query(
        "CREATE TRIGGER recovery_alias_wait BEFORE INSERT ON billing_command_key_binding FOR EACH ROW EXECUTE FUNCTION recovery_alias_wait()",
      );
      const blocker = await f.pool.connect();
      await blocker.query("SELECT pg_advisory_lock(987145)");
      const pending = service
        .recover(
          { ...context(), signal: controller.signal },
          { ...input, idempotencyKey: "cancelled-recovery-key" },
        )
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      let blocked = false;
      try {
        const end = Date.now() + 1000;
        while (Date.now() < end) {
          const r = await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=987145 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
          );
          if (Number(r.rows[0]?.n) > 0) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.abort();
      } finally {
        await blocker.query("SELECT pg_advisory_unlock(987145)");
        blocker.release();
      }
      const result = await pending;
      expect(blocked).toBe(true);
      expect(result.error).toMatchObject({ code: "ABORTED" });
      expect(await funds()).toEqual(before);
      expect(await f.client.billing_command_key_binding.count()).toBe(keys);
    });
    test("formal recover HTTP is proof-free, never creates a missing reservation and returns the original receipt offline", async () => {
      const input = command();
      const headers = wireHeaders();
      delete (headers as Record<string, unknown>)["x-billing-execution-proof"];
      await withHttp(async (http) => {
        const path = "/v1/internal/billing/admissions/recover",
          inject = (payload = wireCommand(input)) =>
            http.inject({ method: "POST", url: path, headers, payload });
        peerEnabled = false;
        const before = await funds();
        const missing = await inject();
        expect(missing.statusCode).toBe(404);
        expect(await funds()).toEqual(before);
        expect(agentCalls).toBe(0);
        expect(iamCalls).toBe(0);
        peerEnabled = true;
        const original = await create(input);
        peerEnabled = false;
        const fundsBefore = await funds();
        const recovered = await inject();
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json()).toMatchObject({
          data: {
            admission_id: original.admissionId,
            run_id: input.runId,
            attempt_id: input.attemptId,
            status: "held",
            created_at: original.createdAt,
            updated_at: original.createdAt,
          },
        });
        expect(await funds()).toEqual(fundsBefore);
        expect(agentCalls).toBe(1);
        expect(iamCalls).toBe(1);
        const again = await inject();
        expect(again.json()).toEqual(recovered.json());
        expect(again.headers["cache-control"]).toBe("no-store");
        expect(await funds()).toEqual(fundsBefore);
      });
    });
    test("recover HTTP rejects proof and caller-controlled identity or financial input before any peer or money", async () => {
      const input = command();
      const headers = wireHeaders();
      delete (headers as Record<string, unknown>)["x-billing-execution-proof"];
      await withHttp(async (http) => {
        const before = await funds(),
          path = "/v1/internal/billing/admissions/recover";
        for (const payload of [
          { ...wireCommand(input), user_id: "victim" },
          { ...wireCommand(input), budget_credits: "1" },
          '{"run_id":"one","run_id":"two"}',
          "\ufeff" + JSON.stringify(wireCommand(input)),
        ])
          expect(
            (await http.inject({ method: "POST", url: path, headers, payload }))
              .statusCode,
          ).toBe(400);
        for (const key of [
          "x-billing-execution-proof",
          "x-billing-consumption-token",
        ])
          expect(
            (
              await http.inject({
                method: "POST",
                url: path,
                headers: { ...headers, [key]: "forbidden" },
                payload: wireCommand(input),
              })
            ).statusCode,
          ).toBe(400);
        for (const url of [
          path + "?alias=1",
          path + "/",
          path.replace("recover", "%72ecover"),
        ])
          expect([400, 404]).toContain(
            (
              await http.inject({
                method: "POST",
                url,
                headers,
                payload: wireCommand(input),
              })
            ).statusCode,
          );
        expect(await funds()).toEqual(before);
        expect(agentCalls).toBe(0);
        expect(iamCalls).toBe(0);
      });
    });
    test("recovery waits behind the original locked admission transaction and returns its only committed hold", async () => {
      const input = command(),
        f = assertDefined(fixture),
        lock = await f.pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM billing_credit_account FOR UPDATE");
      const pending = create(input).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let recover: ReturnType<ModelAdmissionService["recover"]> | undefined,
        blocked = false;
      try {
        const end = Date.now() + 1000;
        while (Date.now() < end) {
          const r = await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id, status, available_micros%'",
          );
          if (Number(r.rows[0]?.n) > 0) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        recover = service.recover(context(), input);
        await new Promise((r) => setTimeout(r, 15));
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
      const result = await pending;
      expect(blocked).toBe(true);
      expect(result.error).toBeUndefined();
      expect(await recover).toEqual(result.value);
      expect((await funds()).holds).toHaveLength(1);
    });
    test("physical duplicate recovery headers reject after identical TCP framing successfully recovers once", async () => {
      const input = command();
      await create(input);
      peerEnabled = false;
      await withHttp(async (http) => {
        await http.listen(0, "127.0.0.1");
        const address = http.getHttpServer().address() as { port: number };
        const body = JSON.stringify(wireCommand(input));
        const headers = wireHeaders();
        delete (headers as Record<string, unknown>)[
          "x-billing-execution-proof"
        ];
        const request = (extras: string[] = []) =>
          new Promise<number>((resolve, reject) => {
            const req = rawRequest(
              {
                host: "127.0.0.1",
                port: address.port,
                path: "/v1/internal/billing/admissions/recover",
                method: "POST",
                headers: [
                  "Host",
                  `127.0.0.1:${address.port}`,
                  "Content-Length",
                  String(Buffer.byteLength(body)),
                  ...Object.entries(headers).flat(),
                  ...extras,
                ],
              },
              (res) => {
                res.resume();
                res.once("end", () => resolve(res.statusCode ?? 0));
              },
            );
            req.setTimeout(2000, () =>
              req.destroy(new Error("recovery raw request deadline")),
            );
            req.once("error", reject);
            req.end(body);
          });
        expect(await request()).toBe(200);
        const before = await funds(),
          keys =
            await assertDefined(
              fixture,
            ).client.billing_command_key_binding.count();
        for (const extras of [
          ["Authorization", headers.authorization],
          ["Content-Type", "application/json"],
          ["IDEMPOTENCY-KEY", "other-recovery-key"],
          [
            "X-Billing-Execution-Proof",
            "one",
            "x-billing-execution-proof",
            "two",
          ],
        ])
          expect([400, 403]).toContain(await request(extras));
        expect(await funds()).toEqual(before);
        expect(
          await assertDefined(
            fixture,
          ).client.billing_command_key_binding.count(),
        ).toBe(keys);
        expect(agentCalls).toBe(1);
        expect(iamCalls).toBe(1);
      });
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
      payerUser = "wrong-payer";
      await expect(create(input)).rejects.toBeDefined();
      expect(await funds()).toEqual(before);
      await expect(
        service.create(
          { ...context(), tenantId: "foreign" },
          input,
          "run-execution-proof-canary",
        ),
      ).rejects.toBeDefined();
      expect(await funds()).toEqual(before);
    });
    test("a correctly shaped IAM response for another Run, conversation, lease or request creates no financial facts", async () => {
      const input = command();
      const before = await funds();
      for (const wrong of [
        { run_id: "different-run" },
        { execution_session_id: "different-conversation" },
        { lease_generation: 2 },
        { request_binding_sha256: "0".repeat(64) },
      ]) {
        decisionDelta = wrong;
        await expect(create(input)).rejects.toMatchObject({
          code: "BINDING_MISMATCH",
        });
        expect(await funds()).toEqual(before);
      }
      expect(iamCalls).toBe(4);
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
          "run-execution-proof-canary",
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
            "run-execution-proof-canary",
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
    test("formal HTTP creates one budget, replays original held, and GET reads current state without peers or writes", async () => {
      const input = command();
      await withHttp(async (http) => {
        const first = await http.inject({
          method: "POST",
          url: "/v1/internal/billing/admissions",
          headers: wireHeaders(),
          payload: wireCommand(input),
        });
        expect(first.statusCode).toBe(201);
        const created = JSON.parse(first.body) as {
          data: {
            admission_id: string;
            status: string;
            updated_at: string;
            created_at: string;
          };
        };
        expect(created.data.status).toBe("held");
        expect(created.data.updated_at).toBe(created.data.created_at);
        expect(first.headers.location).toBe(
          `/v1/internal/billing/admissions/${created.data.admission_id}`,
        );
        const id = created.data.admission_id;
        await assertDefined(fixture).client.billing_admission.update({
          where: { id },
          data: {
            status: "pending_reconciliation",
            updated_at: new Date(Date.now() + 1),
          },
        });
        peerEnabled = false;
        const counts = [agentCalls, iamCalls];
        const keys =
          await assertDefined(
            fixture,
          ).client.billing_command_key_binding.count();
        const before = await funds();
        const readHeaders = wireHeaders();
        delete (readHeaders as Record<string, unknown>)["idempotency-key"];
        delete (readHeaders as Record<string, unknown>)[
          "x-billing-execution-proof"
        ];
        const read = await http.inject({
          method: "GET",
          url: `/v1/internal/billing/admissions/${id}`,
          headers: readHeaders,
        });
        expect(read.statusCode).toBe(200);
        expect(JSON.parse(read.body)).toMatchObject({
          data: { admission_id: id, status: "pending_reconciliation" },
        });
        expect(read.headers["cache-control"]).toBe("no-store");
        expect(
          await assertDefined(
            fixture,
          ).client.billing_command_key_binding.count(),
        ).toBe(keys);
        const replay = await http.inject({
          method: "POST",
          url: "/v1/internal/billing/admissions",
          headers: {
            ...wireHeaders(),
            "idempotency-key": "http-recovery-key",
            "x-billing-execution-proof": "expired-header",
          },
          payload: wireCommand(input),
        });
        expect(replay.statusCode).toBe(201);
        expect(JSON.parse(replay.body)).toEqual(created);
        expect([agentCalls, iamCalls]).toEqual(counts);
        expect(await funds()).toEqual(before);
        const denied = await http.inject({
          method: "GET",
          url: `/v1/internal/billing/admissions/${id}`,
          headers: wireHeaders("another-user"),
        });
        expect(denied.statusCode).toBe(404);
        await assertDefined(fixture).client.billing_admission.update({
          where: { id },
          data: { run_id: "invalid\u0001run" },
        });
        const invalidStored = await http.inject({
          method: "GET",
          url: `/v1/internal/billing/admissions/${id}`,
          headers: wireHeaders(),
        });
        expect(invalidStored.statusCode).toBe(500);
        await assertDefined(fixture).client.billing_admission.update({
          where: { id },
          data: { run_id: input.runId },
        });
        await assertDefined(fixture).client.billing_command_receipt.updateMany({
          where: { command_name: "model.admit" },
          data: { payload_digest: "f".repeat(64) },
        });
        const corrupt = await http.inject({
          method: "GET",
          url: `/v1/internal/billing/admissions/${id}`,
          headers: wireHeaders(),
        });
        expect(corrupt.statusCode).toBe(500);
      });
    });
    test("formal HTTP rejects caller authority, ambiguous flat JSON, partial machine auth, aliases and unknown inputs before peer I/O", async () => {
      const input = command(),
        payload = wireCommand(input),
        path = "/v1/internal/billing/admissions";
      await withHttp(async (http) => {
        for (const bad of [
          JSON.stringify({ ...payload, tenant_id: "forged" }),
          JSON.stringify(payload).replace("{", '{"run_id":"duplicate",'),
          JSON.stringify({ ...payload, run_id: 123 }),
          JSON.stringify({ ...payload, attempt_id: input.attemptId + "\n" }),
        ]) {
          const reply = await http.inject({
            method: "POST",
            url: path,
            headers: wireHeaders(),
            payload: bad,
          });
          expect(reply.statusCode).toBe(400);
        }
        for (const includeNew of [false, true]) {
          const old = {
            ...wireHeaders(),
            "x-billing-consumption-token": "retired-user-token",
          } as Record<string, string>;
          if (!includeNew) delete old["x-billing-execution-proof"];
          const denied = await http.inject({
            method: "POST",
            url: path,
            headers: old,
            payload,
          });
          expect(denied.statusCode).toBe(400);
        }
        const headers = wireHeaders();
        delete (headers as Record<string, unknown>)["x-kokoro-subject"];
        expect(
          (await http.inject({ method: "POST", url: path, headers, payload }))
            .statusCode,
        ).toBe(403);
        expect(
          (
            await http.inject({
              method: "POST",
              url: path + "?alias=1",
              headers: wireHeaders(),
              payload,
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await http.inject({
              method: "POST",
              url: path,
              headers: { ...wireHeaders(), "x-kokoro-service": "agent" },
              payload,
            })
          ).statusCode,
        ).toBe(403);
        expect([agentCalls, iamCalls]).toEqual([0, 0]);
      });
    });
    test("formal HTTP total deadline cancels the outstanding peer read before reservation", async () => {
      const input = command();
      waitForDisconnect = true;
      const before = await funds();
      await withHttp(async (http) => {
        const reply = await http.inject({
          method: "POST",
          url: "/v1/internal/billing/admissions",
          headers: wireHeaders(),
          payload: wireCommand(input),
        });
        expect(reply.statusCode).toBe(503);
        expect(JSON.parse(reply.body)).toMatchObject({
          error: { code: "billing.dependency_unavailable", retryable: true },
        });
        expect([agentCalls, iamCalls]).toEqual([1, 0]);
        expect(await funds()).toEqual(before);
      }, 25);
    });
    test("formal HTTP fails closed on missing prices, insufficient credits, payer mismatch and unavailable peers", async () => {
      const input = command();
      const before = await funds();
      await withHttp(async (http) => {
        const request = () =>
          http.inject({
            method: "POST",
            url: "/v1/internal/billing/admissions",
            headers: wireHeaders(),
            payload: wireCommand(input),
          });
        payerUser = "other-payer";
        const denied = await request();
        expect(denied.statusCode).toBe(403);
        payerUser = actorId;
        peerEnabled = false;
        expect((await request()).statusCode).toBe(503);
        peerEnabled = true;
        await assertDefined(fixture).client.billing_credit_account.updateMany({
          where: { tenant_id: tenantId, subject_id: actorId },
          data: { available_micros: 0n },
        });
        const insufficient = await request();
        expect(insufficient.statusCode).toBe(422);
        expect(JSON.parse(insufficient.body)).toMatchObject({
          error: { code: "billing.insufficient_credit", retryable: false },
        });
        await assertDefined(fixture).client.billing_credit_account.updateMany({
          where: { tenant_id: tenantId, subject_id: actorId },
          data: { available_micros: 100000000n },
        });
        await assertDefined(
          fixture,
        ).client.billing_metering_rate_revision.updateMany({
          where: { tenant_id: tenantId },
          data: { effective_from: new Date("2099-01-01T00:00:00.000Z") },
        });
        const price = await request();
        expect(price.statusCode).toBe(422);
        expect(JSON.parse(price.body)).toMatchObject({
          error: { code: "billing.price_unavailable", retryable: false },
        });
        expect(await funds()).toEqual(before);
      });
    });
    test("formal HTTP rejects GET framing bytes rather than silently ignoring the body", async () => {
      command();
      await withHttp(async (http) => {
        const reply = await http.inject({
          method: "GET",
          url: `/v1/internal/billing/admissions/${randomUUID()}`,
          headers: { ...wireHeaders(), "content-length": "1" },
          payload: "x",
        });
        expect(reply.statusCode).toBe(400);
        expect([agentCalls, iamCalls]).toEqual([0, 0]);
      });
    });
    test("formal HTTP is absent from the default graph until explicitly enabled", async () => {
      const input = command();
      await withHttp(
        async (http) => {
          expect(
            (
              await http.inject({
                method: "POST",
                url: "/v1/internal/billing/admissions",
                headers: wireHeaders(),
                payload: wireCommand(input),
              })
            ).statusCode,
          ).toBe(404);
          expect(
            (
              await http.inject({
                method: "POST",
                url: "/v1/internal/billing/admissions/recover",
                headers: wireHeaders(),
                payload: wireCommand(input),
              })
            ).statusCode,
          ).toBe(404);
          expect([agentCalls, iamCalls]).toEqual([0, 0]);
        },
        10000,
        false,
      );
    });
    test("second-round concurrent receipt recovery respects cancellation without revalidating or changing the committed budget", async () => {
      const input = command();
      await create(input);
      const before = await funds();
      const controller = new AbortController();
      const receipts = assertDefined(app).get(CommandReceiptRepository);
      const keyCount =
        await assertDefined(fixture).client.billing_command_key_binding.count();
      // Model a first miss followed by a competing committed command at the second identity lock.
      const raced = {
        recover: () => Promise.resolve(null),
        execute: async (
          ...args: Parameters<CommandReceiptRepository["execute"]>
        ) => {
          const result = await receipts.execute(...args);
          expect(result.replayed).toBe(true);
          controller.abort();
          return result;
        },
      } as unknown as CommandReceiptRepository;
      const competing = new ModelAdmissionService(
        tx,
        raced,
        assertDefined(app).get(AuditAppender),
        assertDefined(app).get(CreditEffects),
        assertDefined(app).get(MeteringPricingSelectionService),
        reader,
        iam,
      );
      await expect(
        competing.create(
          { ...context(), signal: controller.signal },
          { ...input, idempotencyKey: "raced-recovery-key" },
          "proof-fixture",
        ),
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(await funds()).toEqual(before);
      expect(
        await assertDefined(fixture).client.billing_command_key_binding.count(),
      ).toBe(keyCount);
    });
  },
);
