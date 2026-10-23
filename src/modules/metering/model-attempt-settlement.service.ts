import type { TransactionService } from "../../database/transaction.service.js";
import type { CommandReceiptRepository } from "../../database/command-receipt.repository.js";
import type { AuditAppender } from "../../database/audit-appender.js";
import { CommandReceiptError } from "../../database/command-receipt.error.js";
import type { CreditEffects } from "../credit/credit.public.js";
import type { MeteringService } from "./metering.service.js";
import type { ModelAdmissionService } from "./model-admission.service.js";
import type { AgentUsageEvidenceReader } from "./agent-usage-evidence-reader.js";
import type {
  ModelAdmissionContext,
  ModelAdmissionView,
} from "./model-admission.types.js";
import { ModelAdmissionError } from "./model-admission.error.js";
import {
  modelSettlementIntent,
  modelSettlementResultCodec,
  type ModelSettlementCommand,
  type ModelSettlementResult,
} from "./model-settlement-codec.js";
import {
  settlementExpected,
  assertSettlementAuthorization,
  type SettlementAdmission,
} from "./model-settlement-binding.js";
import {
  bindSealedAgentUsageEvidence,
  decodeAgentUsageEvidence,
  verifyAgentUsageSuccessor,
  type DecodedAgentUsageEvidence,
} from "./agent-usage-evidence.js";
import { decodeFrozenModelPricing } from "./model-settlement-snapshot.js";
import { priceSealedModelAttempt } from "./model-settlement-pricing.js";
import { decideModelAttemptSettlement } from "./model-attempt-settlement.js";

import { verifyModelSettlementFunding } from "./model-settlement-funding.js";

type Intent = ReturnType<typeof modelSettlementIntent>;
/** Existing Metering composition; no network under a funding lock or new live user authorization. */
export class ModelAttemptSettlementService {
  constructor(
    private readonly tx: TransactionService,
    private readonly receipts: CommandReceiptRepository,
    private readonly audit: AuditAppender,
    private readonly credit: CreditEffects,
    private readonly metering: MeteringService,
    private readonly admissions: Pick<ModelAdmissionService, "read">,
    private readonly agent: Pick<AgentUsageEvidenceReader, "read">,
  ) {}
  async settle(
    context: ModelAdmissionContext,
    command: ModelSettlementCommand,
  ): Promise<ModelSettlementResult> {
    const intent = modelSettlementIntent(context, command),
      { context: scope, receipt } = intent;
    const guard = () => {
      if (scope.signal.aborted) throw new ModelAdmissionError("ABORTED");
    };
    const transaction = {
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      operation: "model.settle",
      mode: "write" as const,
    };
    try {
      guard();
      const view = await this.admissions.read(
        scope,
        intent.command.admissionId,
      );
      guard();
      if (view === null) throw new ModelAdmissionError("FORBIDDEN");
      const recovered = await this.tx.runRoot(transaction, async () => {
        const result = await this.receipts.recover(
          receipt,
          modelSettlementResultCodec,
        );
        guard();
        if (result === null) return null;
        const row = await this.lockedRow(intent, view);
        await this.verifyReceipt(result.value, intent, view, row);
        guard();
        return result.value;
      });
      guard();
      if (recovered !== null) return recovered;
      const row = await this.tx.runRoot(transaction, () =>
        this.row(intent, view),
      );
      guard();
      const expected = settlementExpected(row, view, scope, intent.command);
      const read = await this.agent.read({
        expected,
        requestId: scope.requestId,
        signal: scope.signal,
      });
      guard();
      // Rebind even a substituted port to the one owner artifact before using its facts.
      const evidence = bindSealedAgentUsageEvidence(
        Buffer.from(read.originalJson),
        expected,
      );
      assertSettlementAuthorization(row, evidence.evidence);
      return await this.tx.runRoot(transaction, async () => {
        const execution = await this.receipts.execute(
          receipt,
          modelSettlementResultCodec,
          async () => {
            const current = await this.lockedRow(intent, view);
            guard();
            if (
              current.status !== "held" &&
              current.status !== "pending_reconciliation"
            )
              throw new ModelAdmissionError("CONFLICT");
            if (
              current.status === "held" &&
              current.settlement_evidence_json !== null
            )
              throw new ModelAdmissionError("CORRUPT");
            if (current.status === "pending_reconciliation") {
              if (current.settlement_evidence_json === null)
                throw new ModelAdmissionError("CORRUPT");
              await this.verifyPendingHead(intent, view, current);
              if (current.settlement_evidence_json === evidence.originalJson)
                throw new ModelAdmissionError("CORRUPT");
              try {
                verifyAgentUsageSuccessor(
                  Buffer.from(current.settlement_evidence_json),
                  Buffer.from(evidence.originalJson),
                );
              } catch {
                throw new ModelAdmissionError("CONFLICT");
              }
            }
            guard();
            const result = await this.apply(intent, view, current, evidence);
            guard();
            return result;
          },
        );
        const current = await this.lockedRow(intent, view);
        await this.verifyReceipt(execution.value, intent, view, current);
        guard();
        return execution.value;
      });
    } catch (error) {
      if (error instanceof CommandReceiptError)
        throw new ModelAdmissionError(
          error.code === "COMMAND_IDEMPOTENCY_CONFLICT"
            ? "CONFLICT"
            : "CORRUPT",
        );
      throw error;
    }
  }
  private async lockedRow(
    intent: Intent,
    view: ModelAdmissionView,
  ): Promise<SettlementAdmission> {
    const client = this.tx.requireActiveTransaction(
      intent.context.tenantId,
      "write",
    );
    const lock = `model-admission:run:${intent.context.tenantId}:${view.runId}`;
    await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${lock},0))`;
    return this.row(intent, view);
  }
  private async verifyPendingHead(
    intent: Intent,
    view: ModelAdmissionView,
    row: SettlementAdmission,
  ): Promise<void> {
    if (row.settlement_evidence_json === null)
      throw new ModelAdmissionError("CORRUPT");
    try {
      const previous = decodeAgentUsageEvidence(
        Buffer.from(row.settlement_evidence_json),
      ).evidence;
      const prior = modelSettlementIntent(intent.context, {
        admissionId: row.id,
        eventId: previous.identity.event_id,
        revision: previous.revision,
        digest: previous.digest,
        idempotencyKey: "head-validation",
      });
      const commandIdentity = prior.receipt.commandIdentity;
      if (commandIdentity === undefined) throw new Error();
      // Direct validation, not receipt.recover: no extra key locks/bindings under the Run lock.
      const receipt = await this.tx
        .requireActiveTransaction(row.tenant_id, "write")
        .billing_command_receipt.findFirst({
          where: {
            tenant_id: row.tenant_id,
            command_namespace: "admission",
            api_surface: "internal",
            command_name: "model.settle",
            command_identity: commandIdentity,
          },
        });
      if (
        !receipt ||
        receipt.status !== "succeeded" ||
        receipt.request_schema_version !== 1 ||
        receipt.result_schema_version !== 1 ||
        receipt.payload_digest !== prior.receipt.payloadDigest
      )
        throw new Error();
      const result = modelSettlementResultCodec.decode(receipt.result_json);
      if (
        result.status !== "pending_reconciliation" ||
        result.evidenceJson !== row.settlement_evidence_json ||
        result.updatedAt !== row.updated_at.toISOString()
      )
        throw new Error();
      await this.verifyReceipt(result, prior, view, row);
    } catch {
      throw new ModelAdmissionError("CORRUPT");
    }
  }
  private async row(
    intent: Intent,
    view: ModelAdmissionView,
  ): Promise<SettlementAdmission> {
    const row = await this.tx
      .requireActiveTransaction(intent.context.tenantId, "write")
      .billing_admission.findFirst({
        where: {
          id: intent.command.admissionId,
          tenant_id: intent.context.tenantId,
        },
      });
    if (row === null) throw new ModelAdmissionError("FORBIDDEN");
    settlementExpected(row, view, intent.context, intent.command);
    return row;
  }
  private decision(row: SettlementAdmission, e: DecodedAgentUsageEvidence) {
    const pricing = decodeFrozenModelPricing(
      row.pricing_snapshot_json,
      row.pricing_snapshot_digest,
      {
        tenantId: row.tenant_id,
        modelRevision: {
          id: e.evidence.planned.revision_id,
          contentDigest: e.evidence.planned.digest,
        },
        budgetCredits: row.budget_credits.toString(),
      },
    );
    return decideModelAttemptSettlement(
      row.budget_credits * 1_000_000n,
      priceSealedModelAttempt(pricing, e.evidence),
    );
  }
  private async apply(
    intent: Intent,
    view: ModelAdmissionView,
    row: SettlementAdmission,
    e: DecodedAgentUsageEvidence,
  ): Promise<ModelSettlementResult> {
    const decision = this.decision(row, e),
      scope = intent.context,
      client = this.tx.requireActiveTransaction(scope.tenantId, "write"),
      source = `model-usage:${e.evidence.identity.event_id}`;
    let captured = 0n,
      released = 0n,
      usageEventId: string | null = null,
      settlementId: string | null = null;
    if (decision.action === "capture") {
      const usage = e.evidence.usage;
      if (
        usage.state !== "normalized" ||
        usage.value.total.state !== "reported"
      )
        throw new ModelAdmissionError("CORRUPT");
      const result = await this.metering.settleInTransaction({
        tenantId: scope.tenantId,
        actorId: scope.actorId,
        subjectId: scope.actorId,
        holdId: row.hold_id,
        sourceEventId: e.evidence.identity.event_id,
        featureKey: row.feature_key,
        quantity: BigInt(usage.value.total.count),
        actualMicros: decision.captureMicros,
        dimensions: {
          admission_id: row.id,
          pricing_snapshot_digest: row.pricing_snapshot_digest,
          evidence_digest: e.evidence.digest,
        },
      });
      captured = result.capturedMicros;
      released = result.releasedMicros;
      usageEventId = result.usageEventId;
      settlementId = result.settlementId;
    } else if (decision.action === "release") {
      const result = await this.credit.release({
        tenantId: scope.tenantId,
        holdId: row.hold_id,
        sourceRef: source,
      });
      released = result.releasedMicros;
    }
    const status =
      decision.action === "capture"
        ? "captured"
        : decision.action === "release"
          ? "released"
          : "pending_reconciliation";
    const clocks = await client.$queryRaw<
      readonly { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    const now = clocks[0]?.now;
    if (!now) throw new ModelAdmissionError("CORRUPT");
    const updated = await client.billing_admission.updateMany({
      where: {
        id: row.id,
        tenant_id: scope.tenantId,
        status: row.status,
        settlement_evidence_json: row.settlement_evidence_json,
      },
      data: {
        status,
        settlement_evidence_json: e.originalJson,
        updated_at: now,
      },
    });
    if (updated.count !== 1) throw new ModelAdmissionError("CONFLICT");
    await this.audit.append({
      tenantId: scope.tenantId,
      action: "model.settle",
      subjectId: scope.actorId,
      resourceType: "model_admission",
      resourceId: row.id,
      reason: "Verified sealed model attempt evidence",
      payload: {
        eventId: e.evidence.identity.event_id,
        revision: e.evidence.revision,
        digest: e.evidence.digest,
        status,
        capturedMicros: captured.toString(),
        releasedMicros: released.toString(),
      },
    });
    return modelSettlementResultCodec.decode({
      schemaVersion: 1,
      admissionId: view.admissionId,
      eventId: e.evidence.identity.event_id,
      revision: e.evidence.revision,
      digest: e.evidence.digest,
      status,
      reason:
        decision.action === "pending_reconciliation" ? decision.reason : null,
      capturedMicros: captured.toString(),
      releasedMicros: released.toString(),
      usageEventId,
      settlementId,
      updatedAt: now.toISOString(),
      evidenceJson: e.originalJson,
    });
  }
  private async verifyReceipt(
    result: ModelSettlementResult,
    intent: Intent,
    view: ModelAdmissionView,
    row: SettlementAdmission,
  ): Promise<void> {
    const command = intent.command;
    if (
      result.admissionId !== command.admissionId ||
      result.eventId !== command.eventId ||
      result.revision !== command.revision ||
      result.digest !== command.digest
    )
      throw new ModelAdmissionError("CORRUPT");
    const e = bindSealedAgentUsageEvidence(
      Buffer.from(result.evidenceJson),
      settlementExpected(row, view, intent.context, command),
    );
    assertSettlementAuthorization(row, e.evidence);
    const decision = this.decision(row, e),
      capture = decision.action === "capture" ? decision.captureMicros : 0n,
      release =
        decision.action === "release"
          ? decision.releaseMicros
          : decision.action === "capture"
            ? decision.releaseMicros
            : 0n;
    const status =
      decision.action === "capture"
        ? "captured"
        : decision.action === "release"
          ? "released"
          : "pending_reconciliation";
    if (
      result.status !== status ||
      BigInt(result.capturedMicros) !== capture ||
      BigInt(result.releasedMicros) !== release ||
      result.reason !==
        (decision.action === "pending_reconciliation" ? decision.reason : null)
    )
      throw new ModelAdmissionError("CORRUPT");
    await verifyModelSettlementFunding(this.tx, row, result, e);
  }
}
