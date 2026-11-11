import { InternalServerErrorException } from "@nestjs/common";
import type { AdmissionSettlementResponse } from "../../generated/billing-api/types.gen.js";
import type { ModelSettlementResult } from "./model-settlement-codec.js";
function credits(value: string): string {
  if (!/^(?:0|[1-9][0-9]{0,18})$(?![\s\S])/u.test(value))
    throw new InternalServerErrorException();
  const n = BigInt(value);
  if (n > 9223372036854775807n || n % 1_000_000n !== 0n)
    throw new InternalServerErrorException();
  return (n / 1_000_000n).toString();
}
/** Explicit public projection: the durable private evidence JSON never crosses this boundary. */
export function mapModelSettlement(
  value: ModelSettlementResult,
): AdmissionSettlementResponse {
  const base = {
    admission_id: value.admissionId,
    run_id: value.runId,
    attempt_id: value.attemptId,
    evidence_event_id: value.eventId,
    evidence_revision: value.revision,
    evidence_digest: value.digest,
    captured_credits: credits(value.capturedMicros),
    released_credits: credits(value.releasedMicros),
    updated_at: value.updatedAt,
  };
  if (value.status === "captured") {
    if (
      value.reason !== null ||
      value.usageEventId === null ||
      value.settlementId === null
    )
      throw new InternalServerErrorException();
    return {
      data: {
        ...base,
        status: "captured",
        reason: null,
        usage_event_id: value.usageEventId,
        settlement_id: value.settlementId,
      },
    };
  }
  if (
    value.usageEventId !== null ||
    value.settlementId !== null ||
    base.captured_credits !== "0"
  )
    throw new InternalServerErrorException();
  if (value.status === "released") {
    if (value.reason !== null) throw new InternalServerErrorException();
    return {
      data: {
        ...base,
        status: "released",
        reason: null,
        captured_credits: "0",
        usage_event_id: null,
        settlement_id: null,
      },
    };
  }
  if (value.reason === null || base.released_credits !== "0")
    throw new InternalServerErrorException();
  return {
    data: {
      ...base,
      status: "pending_reconciliation",
      reason: value.reason,
      captured_credits: "0",
      released_credits: "0",
      usage_event_id: null,
      settlement_id: null,
    },
  };
}
