import type { AdmissionResponse } from "../../generated/billing-api/types.gen.js";
import type { ModelAdmissionView } from "./model-admission.types.js";
export function mapModelAdmission(
  value: ModelAdmissionView,
): AdmissionResponse {
  return {
    data: {
      admission_id: value.admissionId,
      run_id: value.runId,
      attempt_id: value.attemptId,
      request_ref: value.requestRef,
      attempt_binding_digest: value.attemptBindingDigest,
      planned_digest: value.plannedDigest,
      final_request_digest: value.finalRequestDigest,
      hold_id: value.holdId,
      budget_credits: value.budgetCredits,
      pricing_snapshot_digest: value.pricingSnapshotDigest,
      status: value.status,
      created_at: value.createdAt,
      updated_at: value.updatedAt,
    },
  };
}
