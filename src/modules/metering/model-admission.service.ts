import { createHash, randomUUID } from "node:crypto";
import type { TransactionService } from "../../database/transaction.service.js";
import type { CommandReceiptRepository } from "../../database/command-receipt.repository.js";
import { CommandReceiptError } from "../../database/command-receipt.error.js";
import type { AuditAppender } from "../../database/audit-appender.js";
import { CreditError, type CreditEffects } from "../credit/credit.public.js";
import { AgentUsageReaderError } from "./agent-usage-evidence-reader.error.js";
import { IamBillingAuthorizationError } from "./iam-billing-authorization.error.js";
import { MeteringError } from "./metering.error.js";
import { canonicalAgentUsageJson } from "./agent-usage-json.js";
import type { MeteringPricingSelectionService } from "./metering-pricing-selection.service.js";
import type { AgentUsageEvidenceReader } from "./agent-usage-evidence-reader.js";
import type { IamBillingAuthorizationClient } from "./iam-billing-authorization.client.js";
import { currentMeteringProfileRef } from "./metering-policy-artifact.js";
import {
  modelAdmissionIntent,
  modelAdmissionResultCodec,
  encodeModelAdmissionPricing,
} from "./model-admission-codec.js";
import type {
  ModelAdmissionContext,
  ModelAdmissionCommand,
  ModelAdmissionResult,
} from "./model-admission.types.js";
import { ModelAdmissionError } from "./model-admission.error.js";

/** First admission only. No provider execution, capture, TTL release, or network I/O under a DB lock. */
export class ModelAdmissionService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly receipts: CommandReceiptRepository,
    private readonly audit: AuditAppender,
    private readonly credit: CreditEffects,
    private readonly pricing: MeteringPricingSelectionService,
    private readonly agent: Pick<AgentUsageEvidenceReader, "readPrepared">,
    private readonly iam: Pick<IamBillingAuthorizationClient, "authorize">,
  ) {}
  async create(
    context: ModelAdmissionContext,
    command: ModelAdmissionCommand,
    consumptionToken: string,
  ): Promise<ModelAdmissionResult> {
    const intent = modelAdmissionIntent(context, command);
    const { expected, receipt } = intent;
    const scope = {
      tenantId: intent.context.tenantId,
      actorId: intent.context.actorId,
      operation: "model.admit",
      mode: "write" as const,
    };
    const { signal, requestId, actorId, tenantId } = intent.context;
    const checkCancelled = () => {
      if (signal.aborted) throw new ModelAdmissionError("ABORTED");
    };
    try {
      checkCancelled();
      const previous = await this.transactions.runRoot(scope, async () => {
        const found = await this.receipts.recover(
          receipt,
          modelAdmissionResultCodec,
        );
        if (found === null) return null;
        await this.#assertCommitted(found.value, intent);
        return found.value;
      });
      if (previous !== null) return previous;
      // Existing results above survive peer/token expiry. New reservations require fresh owner checks.
      const prepared = await this.agent.readPrepared({
        expected,
        requestId,
        signal,
      });
      if (
        prepared.identity.actor.kind !== "user" ||
        prepared.identity.subject.kind !== "user" ||
        prepared.identity.actor.opaque_ref !== actorId ||
        prepared.identity.subject.opaque_ref !== actorId ||
        prepared.planned.feature_key.length > 128 ||
        BigInt(prepared.identity.attempt_ordinal) > 9223372036854775807n
      )
        throw new ModelAdmissionError("FORBIDDEN");
      const authorization = await this.iam.authorize({
        tenantId,
        billingSubject: { kind: "user", ref: actorId },
        consumptionToken,
        requestId,
        signal,
      });
      if (authorization.payerUserId !== actorId)
        throw new ModelAdmissionError("FORBIDDEN");
      checkCancelled();
      const checkLiveBounds = async () => {
        const client = this.transactions.requireActiveTransaction(
          tenantId,
          "write",
        );
        const clocks = await client.$queryRaw<
          readonly { db_now: Date }[]
        >`SELECT clock_timestamp() AS db_now`;
        const now = clocks[0]?.db_now;
        if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
          throw new ModelAdmissionError("CORRUPT");
        if (
          Date.parse(prepared.leaseExpiresAt) <= now.getTime() ||
          !Number.isFinite(Date.parse(authorization.expiresAt)) ||
          Date.parse(authorization.expiresAt) <= now.getTime()
        )
          throw new ModelAdmissionError("EXPIRED");
        checkCancelled();
      };
      return await this.transactions.runRoot(scope, async () => {
        const execution = await this.receipts.execute(
          receipt,
          modelAdmissionResultCodec,
          async () => {
            const client = this.transactions.requireActiveTransaction(
              tenantId,
              "write",
            );
            for (const key of [
              `model-admission:run:${tenantId}:${expected.runId}`,
              `model-admission:request:${tenantId}:${expected.requestRef}`,
            ].sort())
              await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${key},0))`;
            if (
              await client.billing_admission.findFirst({
                where: {
                  tenant_id: tenantId,
                  request_ref: expected.requestRef,
                },
              })
            )
              throw new ModelAdmissionError("CONFLICT");
            if (
              await client.billing_admission.findFirst({
                where: {
                  tenant_id: tenantId,
                  run_id: expected.runId,
                  status: "pending_reconciliation",
                },
              })
            )
              throw new ModelAdmissionError("RUN_BLOCKED");
            await checkLiveBounds();
            const pricing = await this.pricing.freezeActivePricing({
              tenantId,
              profileRef: currentMeteringProfileRef,
              modelRevision: {
                id: prepared.planned.revision_id,
                contentDigest: prepared.planned.digest,
              },
            });
            const snapshot = encodeModelAdmissionPricing(pricing);
            const budget = BigInt(pricing.policy.maxAttemptCredits);
            const account = await this.credit.openMyAccount({
              tenantId,
              subjectId: actorId,
            });
            const hold = await this.credit.reserve({
              tenantId,
              accountId: account.id,
              idempotencyKey: `model-attempt:${expected.attemptId}`,
              requestedMicros: budget * 1_000_000n,
              featureKey: prepared.planned.feature_key,
              expiresAt: null,
            });
            checkCancelled();
            const admissionId = randomUUID();
            const row = await client.billing_admission.create({
              data: {
                id: admissionId,
                tenant_id: tenantId,
                run_id: expected.runId,
                attempt_id: expected.attemptId,
                request_ref: expected.requestRef,
                actor_ref: actorId,
                payer_ref: authorization.payerUserId,
                call_id: prepared.identity.call_id,
                attempt_ordinal: BigInt(prepared.identity.attempt_ordinal),
                feature_key: prepared.planned.feature_key,
                attempt_binding_json: prepared.original.attemptBindingJson,
                attempt_binding_digest: expected.attemptBindingDigest,
                planned_json: prepared.original.plannedJson,
                planned_digest: expected.plannedDigest,
                authorization_json: prepared.original.authorizationJson,
                final_request_digest: expected.finalRequestDigest,
                prepared_at: new Date(prepared.preparedAt),
                observed_at: new Date(prepared.observedAt),
                lease_expires_at: new Date(prepared.leaseExpiresAt),
                pricing_snapshot_json: snapshot.json,
                pricing_snapshot_digest: snapshot.digest,
                budget_credits: budget,
                hold_id: hold.holdId,
                status: "held",
              },
            });
            await this.audit.append({
              tenantId,
              action: "model.admit",
              subjectId: actorId,
              resourceType: "model_admission",
              resourceId: admissionId,
              reason: "Verified model attempt budget reservation",
              payload: {
                runId: expected.runId,
                attemptId: expected.attemptId,
                holdId: hold.holdId,
                budgetCredits: budget.toString(),
                pricingSnapshotDigest: snapshot.digest,
              },
            });
            return modelAdmissionResultCodec.decode({
              schemaVersion: 1,
              admissionId,
              tenantId,
              runId: expected.runId,
              attemptId: expected.attemptId,
              requestRef: expected.requestRef,
              holdId: hold.holdId,
              budgetCredits: budget.toString(),
              pricingSnapshotDigest: snapshot.digest,
              createdAt: row.created_at.toISOString(),
            });
          },
        );
        await this.#assertCommitted(execution.value, intent);
        // All reservation/audit/receipt awaits have settled. Old receipt recovery is not a new lease.
        if (!execution.replayed) await checkLiveBounds();
        return execution.value;
      });
    } catch (error) {
      if (error instanceof CommandReceiptError)
        throw new ModelAdmissionError(
          error.code === "COMMAND_IDEMPOTENCY_CONFLICT"
            ? "CONFLICT"
            : "CORRUPT",
        );
      if (
        error instanceof ModelAdmissionError ||
        error instanceof CreditError ||
        error instanceof AgentUsageReaderError ||
        error instanceof IamBillingAuthorizationError ||
        error instanceof MeteringError
      )
        throw error;
      throw new ModelAdmissionError("UNAVAILABLE");
    }
  }
  async #assertCommitted(
    result: ModelAdmissionResult,
    intent: ReturnType<typeof modelAdmissionIntent>,
  ): Promise<void> {
    const { expected, context } = intent;
    const client = this.transactions.requireActiveTransaction(
      context.tenantId,
      "write",
    );
    const row = await client.billing_admission.findFirst({
      where: { id: result.admissionId, tenant_id: context.tenantId },
    });
    const hold = await client.billing_credit_hold.findFirst({
      where: { id: result.holdId, tenant_id: context.tenantId },
    });
    const account =
      hold === null
        ? null
        : await client.billing_credit_account.findFirst({
            where: { id: hold.credit_account_id, tenant_id: context.tenantId },
          });
    if (
      !row ||
      !hold ||
      !account ||
      result.tenantId !== context.tenantId ||
      result.runId !== expected.runId ||
      result.attemptId !== expected.attemptId ||
      result.requestRef !== expected.requestRef ||
      row.run_id !== expected.runId ||
      row.attempt_id !== expected.attemptId ||
      row.request_ref !== expected.requestRef ||
      row.actor_ref !== context.actorId ||
      row.payer_ref !== context.actorId ||
      account.subject_id !== context.actorId ||
      row.hold_id !== result.holdId ||
      row.budget_credits.toString() !== result.budgetCredits ||
      hold.requested_micros !== row.budget_credits * 1_000_000n ||
      hold.expires_at !== null ||
      row.attempt_binding_digest !== expected.attemptBindingDigest ||
      row.planned_digest !== expected.plannedDigest ||
      row.authorization_json !==
        canonicalAgentUsageJson({
          request_ref: expected.requestRef,
          state: "requested_unknown",
        }) ||
      row.final_request_digest !== expected.finalRequestDigest ||
      row.pricing_snapshot_digest !== result.pricingSnapshotDigest ||
      createHash("sha256").update(row.pricing_snapshot_json).digest("hex") !==
        result.pricingSnapshotDigest ||
      createHash("sha256").update(row.attempt_binding_json).digest("hex") !==
        expected.attemptBindingDigest ||
      createHash("sha256").update(row.planned_json).digest("hex") !==
        expected.plannedDigest ||
      row.created_at.toISOString() !== result.createdAt
    )
      throw new ModelAdmissionError("CORRUPT");
  }
}
