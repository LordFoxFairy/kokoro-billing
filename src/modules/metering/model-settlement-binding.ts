import type { TransactionClient } from "../../database/transaction.types.js";
import type {
  ModelAdmissionContext,
  ModelAdmissionView,
} from "./model-admission.types.js";
import type { ModelSettlementCommand } from "./model-settlement-codec.js";
import { decodeStoredPreparedBinding } from "./agent-prepared-call.js";
import { ModelAdmissionError } from "./model-admission.error.js";
import type {
  ExpectedAgentUsageEvidence,
  Frozen,
} from "./agent-usage-evidence.js";
import type { ModelUsageEvidence } from "../../generated/agent-usage-v2/types.gen.js";
export type SettlementAdmission = Awaited<
  ReturnType<TransactionClient["billing_admission"]["findMany"]>
>[number];
export function settlementExpected(
  row: SettlementAdmission,
  view: ModelAdmissionView,
  context: ModelAdmissionContext,
  command: ModelSettlementCommand,
): ExpectedAgentUsageEvidence {
  if (
    row.id !== view.admissionId ||
    row.tenant_id !== context.tenantId ||
    row.actor_ref !== context.actorId ||
    row.payer_ref !== context.actorId ||
    row.hold_id !== view.holdId ||
    row.run_id !== view.runId ||
    row.attempt_id !== view.attemptId ||
    row.request_ref !== view.requestRef ||
    row.attempt_binding_digest !== view.attemptBindingDigest ||
    row.planned_digest !== view.plannedDigest ||
    row.final_request_digest !== view.finalRequestDigest ||
    row.pricing_snapshot_digest !== view.pricingSnapshotDigest ||
    row.budget_credits.toString() !== view.budgetCredits
  )
    throw new ModelAdmissionError("CORRUPT");
  try {
    const binding = decodeStoredPreparedBinding({
      attemptBindingJson: row.attempt_binding_json,
      attemptBindingDigest: row.attempt_binding_digest,
      plannedJson: row.planned_json,
      plannedDigest: row.planned_digest,
    });
    if (
      binding.identity.tenant_ref !== context.tenantId ||
      binding.identity.run_id !== row.run_id ||
      binding.identity.attempt_id !== row.attempt_id ||
      binding.identity.actor.kind !== "user" ||
      binding.identity.subject.kind !== "user" ||
      binding.identity.actor.opaque_ref !== context.actorId ||
      binding.identity.subject.opaque_ref !== context.actorId ||
      binding.planned.feature_key !== row.feature_key
    )
      throw new Error();
    return {
      identity: { ...binding.identity, event_id: command.eventId },
      planned: binding.planned,
      revision: command.revision,
      digest: command.digest,
    };
  } catch {
    throw new ModelAdmissionError("CORRUPT");
  }
}
export function assertSettlementAuthorization(
  row: SettlementAdmission,
  e: Frozen<ModelUsageEvidence>,
): void {
  const auth = e.authorization_observation;
  if (
    e.execution.prepared_at !== row.prepared_at.toISOString() ||
    e.observed_at < e.execution.prepared_at ||
    (e.execution.dispatch_started_at !== null &&
      (e.execution.dispatch_started_at < e.execution.prepared_at ||
        e.observed_at < e.execution.dispatch_started_at)) ||
    (auth.state !== "not_requested" && auth.request_ref !== row.request_ref) ||
    (auth.state === "granted" && auth.admission_ref !== row.id) ||
    (e.execution.dispatch_started_at !== null && auth.state !== "granted")
  )
    throw new ModelAdmissionError("CORRUPT");
}
