import type { TransactionPort } from '../../ports/transaction.js';
import type { BillingAdmissionRepository } from '../ports/metering-repository.js';

export type BillingSubject = { readonly kind: 'user' | 'project' | 'organization' | 'service'; readonly ref: string };
export type CreateBillingAdmissionInput = { readonly tenantId: string; readonly billingSubject: BillingSubject; readonly payerRef: string; readonly featureKey: string; readonly surface: string; readonly invocationId: string; readonly executionId: string; readonly meterKind: 'model_invocation' | 'feature' | 'studio_job'; readonly requestedModelTier?: string; readonly idempotencyKey: string };
export type BillingAdmissionResult = { readonly admissionId: string; readonly holdId: string | null; readonly mode: 'included' | 'credit' | 'payg' | 'rejected'; readonly pricePolicyRevisionId: string | null; readonly amountMicros: string; readonly currency: 'CRD'; readonly status: 'held' | 'accepted_without_charge' | 'rejected' };
export type AcceptedReceipt = { readonly invocationId: string; readonly executionId: string; readonly acceptedProviderRef: string; readonly acceptedAt: Date; readonly serviceReceipt: Record<string, unknown>; readonly receiptSchemaVersion: string };
export type ExecutionEventInput = { readonly tenantId: string; readonly eventId: string; readonly eventType: 'execution.waiting' | 'execution.accepted' | 'execution.rejected' | 'execution.failed' | 'execution.unknown'; readonly executionId: string; readonly invocationId: string; readonly occurredAt: Date; readonly receiptSchemaVersion: string; readonly receipt?: Record<string, unknown> };

export class BillingAdmissionService {
  public constructor(private readonly repository: BillingAdmissionRepository, private readonly transaction: TransactionPort) {}
  public create(input: CreateBillingAdmissionInput): Promise<BillingAdmissionResult> { return this.transaction.withTransaction(() => this.repository.create(input)); }
  public capture(tenantId: string, admissionId: string, receipt: AcceptedReceipt, idempotencyKey: string): Promise<BillingAdmissionResult> { return this.transaction.withTransaction(() => this.repository.capture(tenantId, admissionId, receipt, idempotencyKey)); }
  public release(tenantId: string, admissionId: string, reason: string, idempotencyKey: string): Promise<BillingAdmissionResult> { return this.transaction.withTransaction(() => this.repository.release(tenantId, admissionId, reason, idempotencyKey)); }
  public recordExecutionEvent(input: ExecutionEventInput): Promise<{ readonly eventId: string; readonly status: 'received' | 'processed' }> { return this.transaction.withTransaction(() => this.repository.recordExecutionEvent(input)); }
  public processExecutionEvent(tenantId: string, eventId: string): Promise<void> { return this.transaction.withTransaction(() => this.repository.processExecutionEvent(tenantId, eventId)); }
}
