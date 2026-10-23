import type { TransactionService } from "../../database/transaction.service.js";
import { commandDigest } from "../../database/canonical-digest.js";
import { ModelAdmissionError } from "./model-admission.error.js";
import type { ModelSettlementResult } from "./model-settlement-codec.js";
import type { SettlementAdmission } from "./model-settlement-binding.js";
import type { DecodedAgentUsageEvidence } from "./agent-usage-evidence.js";

/** Check durable effects, never re-run a funding command while recovering an ACK. */
export async function verifyModelSettlementFunding(
  tx: TransactionService,
  row: SettlementAdmission,
  result: ModelSettlementResult,
  evidence: DecodedAgentUsageEvidence,
): Promise<void> {
  const corrupt = () => {
    throw new ModelAdmissionError("CORRUPT");
  };
  const client = tx.requireActiveTransaction(row.tenant_id, "write");
  const hold = await client.billing_credit_hold.findFirst({
    where: { id: row.hold_id, tenant_id: row.tenant_id },
  });
  if (
    !hold ||
    hold.requested_micros !== row.budget_credits * 1_000_000n ||
    row.settlement_evidence_json === null ||
    row.status === "held"
  )
    return corrupt();
  if (result.status === "pending_reconciliation") {
    // Earlier pending ACKs remain immutable after a later evidence revision settles.
    if (result.usageEventId !== null || result.settlementId !== null)
      return corrupt();
    if (
      row.status === "pending_reconciliation" &&
      (hold.status !== "active" ||
        hold.captured_micros !== 0n ||
        hold.released_micros !== 0n ||
        hold.terminal_source_ref !== null)
    )
      return corrupt();
    return;
  }
  if (
    row.status !== result.status ||
    row.settlement_evidence_json !== result.evidenceJson ||
    row.updated_at.toISOString() !== result.updatedAt ||
    hold.status !== result.status ||
    hold.captured_micros !== BigInt(result.capturedMicros) ||
    hold.released_micros !== BigInt(result.releasedMicros)
  )
    return corrupt();
  if (result.status === "released") {
    if (
      result.usageEventId !== null ||
      result.settlementId !== null ||
      hold.terminal_source_ref !== `model-usage:${result.eventId}`
    )
      return corrupt();
    const events = await client.billing_usage_event.count({
      where: { tenant_id: row.tenant_id, credit_hold_id: row.hold_id },
    });
    const settlements = await client.billing_usage_settlement.count({
      where: { tenant_id: row.tenant_id, credit_hold_id: row.hold_id },
    });
    if (events !== 0 || settlements !== 0) return corrupt();
    return;
  }
  if (
    result.usageEventId === null ||
    result.settlementId === null ||
    hold.terminal_source_ref !== result.usageEventId
  )
    return corrupt();
  const settlement = await client.billing_usage_settlement.findFirst({
    where: {
      id: result.settlementId,
      tenant_id: row.tenant_id,
      credit_hold_id: row.hold_id,
      usage_event_id: result.usageEventId,
      status: "settled",
      actual_micros: BigInt(result.capturedMicros),
    },
  });
  const usage = await client.billing_usage_event.findFirst({
    where: {
      id: result.usageEventId,
      tenant_id: row.tenant_id,
      credit_hold_id: row.hold_id,
      subject_id: row.payer_ref,
      source_event_id: result.eventId,
      feature_key: row.feature_key,
      status: "settled",
    },
  });
  const observed = evidence.evidence.usage;
  if (
    !settlement ||
    !usage ||
    observed.state !== "normalized" ||
    observed.value.total.state !== "reported" ||
    usage.quantity !== BigInt(observed.value.total.count) ||
    commandDigest({ dimensions: usage.dimensions_json }) !==
      commandDigest({
        dimensions: {
          admission_id: row.id,
          pricing_snapshot_digest: row.pricing_snapshot_digest,
          evidence_digest: result.digest,
        },
      })
  )
    return corrupt();
}
