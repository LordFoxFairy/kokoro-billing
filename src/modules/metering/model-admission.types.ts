import type { ExpectedPreparedModelCall } from "./agent-prepared-call.js";
export type ModelAdmissionView = ModelAdmissionResult &
  Readonly<{
    attemptBindingDigest: string;
    plannedDigest: string;
    finalRequestDigest: string;
    status: "held" | "captured" | "released" | "pending_reconciliation";
    updatedAt: string;
  }>;
export type ModelAdmissionContext = Readonly<{
  tenantId: string;
  actorId: string;
  requestId: string;
  signal: AbortSignal;
}>;
export type ModelAdmissionCommand = Omit<
  ExpectedPreparedModelCall,
  "tenantId"
> &
  Readonly<{ idempotencyKey: string }>;
export type ModelAdmissionResult = Readonly<{
  schemaVersion: 1;
  admissionId: string;
  tenantId: string;
  runId: string;
  attemptId: string;
  requestRef: string;
  holdId: string;
  budgetCredits: string;
  pricingSnapshotDigest: string;
  createdAt: string;
}>;
