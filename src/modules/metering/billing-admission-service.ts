import { createHash, randomUUID } from 'node:crypto';
import type { Connection, ResultSetHeader, RowDataPacket } from '../../../src/infrastructure/postgres/connection.js';
import type { UsageSettlementService } from './usage-settlement-service.js';
import { readSafeInteger } from '../../infrastructure/postgres/safe-integer.js';
import { assertTransition, type AdmissionStatus } from '../../domain/billing-state-machine.js';

export type BillingSubject = { readonly kind: 'user' | 'project' | 'organization' | 'service'; readonly ref: string };
export type CreateBillingAdmissionInput = {
  readonly tenantId: string;
  readonly billingSubject: BillingSubject;
  readonly payerRef: string;
  readonly featureKey: string;
  readonly surface: string;
  readonly invocationId: string;
  readonly executionId: string;
  readonly meterKind: 'model_invocation' | 'feature' | 'studio_job';
  readonly requestedModelTier?: string;
  readonly idempotencyKey: string;
};
export type BillingAdmissionResult = {
  readonly admissionId: string;
  readonly holdId: string | null;
  readonly mode: 'included' | 'credit' | 'payg' | 'rejected';
  readonly pricePolicyRevisionId: string | null;
  readonly amountMicros: string;
  readonly currency: 'CRD';
  readonly status: 'held' | 'accepted_without_charge' | 'rejected';
};
export type AcceptedReceipt = {
  readonly invocationId: string;
  readonly executionId: string;
  readonly acceptedProviderRef: string;
  readonly acceptedAt: Date;
  readonly serviceReceipt: Record<string, unknown>;
  readonly receiptSchemaVersion: string;
};
export type ExecutionEventInput = {
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventType: 'execution.waiting' | 'execution.accepted' | 'execution.rejected' | 'execution.failed' | 'execution.unknown';
  readonly executionId: string;
  readonly invocationId: string;
  readonly occurredAt: Date;
  readonly receiptSchemaVersion: string;
  readonly receipt?: Record<string, unknown>;
  readonly signature: string;
};

type AdmissionRow = RowDataPacket & {
  admission_id: string; tenant_id: string; invocation_id: string; execution_id: string;
  feature_key: string; billing_subject_kind: string; billing_subject_ref: string; payer_ref: string;
  surface: string; meter_kind: string; requested_model_tier: string | null;
  price_policy_revision_id: string | null; amount_micros: string | number; mode: 'included' | 'credit' | 'payg' | 'rejected';
  status: AdmissionStatus; hold_id: string | null; accepted_provider_ref: string | null; accepted_at: Date | string | null;
};
type ReceiptRow = RowDataPacket & { payload_hash: string; status: 'processing' | 'succeeded' | 'failed' | 'unknown'; result_json: string | Record<string, unknown> | null };

/** The single application service for the target invocation billing loop. */
export class BillingAdmissionService {
  public constructor(private readonly connection: Connection, private readonly usage: Pick<UsageSettlementService, 'authorizeUsage' | 'settleUsage' | 'releaseUsage' | 'ensureUsageEventForHold'>) {}

  public async create(input: CreateBillingAdmissionInput): Promise<BillingAdmissionResult> {
    const payload = { ...input, requestedModelTier: input.requestedModelTier ?? null };
    const receipt = await this.beginReceipt(input.tenantId, 'internal', 'AuthorizeAdmission', input.idempotencyKey, payload);
    if (receipt !== null) return receipt as BillingAdmissionResult;
    try {
      const [existingRows] = await this.connection.execute<AdmissionRow[]>(
        'SELECT * FROM entitlement_billing_admission WHERE tenant_id = $1 AND invocation_id = $2 FOR UPDATE',
        [input.tenantId, input.invocationId],
      );
      const existing = existingRows[0];
      if (existing) {
        const result = this.toResult(existing);
        await this.finishReceipt(input.tenantId, 'internal', 'AuthorizeAdmission', input.idempotencyKey, result);
        return result;
      }

      const [rates] = await this.connection.execute<(RowDataPacket & { usage_price_revision_id: string; reservation_micros: string | number })[]>(
        `SELECT r.usage_price_revision_id, r.reservation_micros
           FROM entitlement_usage_price_rate r
           INNER JOIN entitlement_usage_price_revision p
             ON p.usage_price_revision_id = r.usage_price_revision_id AND p.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND r.feature_key = $2 AND r.label_key IS NULL AND r.status = 'active'
            AND p.status = 'published' AND p.effective_from <= CURRENT_TIMESTAMP(6)
            AND (p.effective_to IS NULL OR p.effective_to > CURRENT_TIMESTAMP(6))
          ORDER BY p.revision DESC, r.usage_price_rate_id DESC LIMIT 1`,
        [input.tenantId, input.featureKey],
      );
      const rate = rates[0];
      if (!rate) throw new Error('billing.price_unavailable');
      const amountMicros = readSafeInteger(rate.reservation_micros, 'reservation_micros');
      const admissionId = randomUUID();
      if (amountMicros === 0) {
        await this.connection.execute(
          `INSERT INTO entitlement_billing_admission
            (admission_id, tenant_id, billing_subject_kind, billing_subject_ref, payer_ref, feature_key, surface,
             invocation_id, execution_id, meter_kind, requested_model_tier, price_policy_revision_id,
             amount_micros, mode, status, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, 'included', 'captured', $13)`,
          [admissionId, input.tenantId, input.billingSubject.kind, input.billingSubject.ref, input.payerRef, input.featureKey, input.surface, input.invocationId, input.executionId, input.meterKind, input.requestedModelTier ?? null, rate.usage_price_revision_id, input.idempotencyKey],
        );
        const result: BillingAdmissionResult = { admissionId, holdId: null, mode: 'included', pricePolicyRevisionId: rate.usage_price_revision_id, amountMicros: '0', currency: 'CRD', status: 'accepted_without_charge' };
        const accepted = { ...result, status: 'accepted_without_charge' as const };
        await this.finishReceipt(input.tenantId, 'internal', 'AuthorizeAdmission', input.idempotencyKey, accepted);
        return accepted;
      }

      const accountId = await this.ensureCreditAccount(input.tenantId, input.billingSubject.ref);
      const hold = await this.usage.authorizeUsage({
        tenantId: input.tenantId, accountId, requestedMicros: amountMicros, featureKey: input.featureKey,
        idempotencyKey: `admission:${input.invocationId}`,
        pricingRevisionId: rate.usage_price_revision_id,
      });
      await this.connection.execute(
        `INSERT INTO entitlement_billing_admission
          (admission_id, tenant_id, billing_subject_kind, billing_subject_ref, payer_ref, feature_key, surface,
           invocation_id, execution_id, meter_kind, requested_model_tier, price_policy_revision_id,
           amount_micros, mode, status, hold_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'credit', 'held', $14, $15)`,
        [admissionId, input.tenantId, input.billingSubject.kind, input.billingSubject.ref, input.payerRef, input.featureKey, input.surface, input.invocationId, input.executionId, input.meterKind, input.requestedModelTier ?? null, rate.usage_price_revision_id, amountMicros, hold.holdId, input.idempotencyKey],
      );
      const result: BillingAdmissionResult = { admissionId, holdId: hold.holdId, mode: 'credit', pricePolicyRevisionId: rate.usage_price_revision_id, amountMicros: String(amountMicros), currency: 'CRD', status: 'held' };
      await this.finishReceipt(input.tenantId, 'internal', 'AuthorizeAdmission', input.idempotencyKey, result);
      return result;
    } catch (error) {
      await this.failReceipt(input.tenantId, 'internal', 'AuthorizeAdmission', input.idempotencyKey, error);
      throw error;
    }
  }

  public async capture(tenantId: string, admissionId: string, receipt: AcceptedReceipt, idempotencyKey: string): Promise<BillingAdmissionResult> {
    const admission = await this.getAdmission(tenantId, admissionId);
    if (admission.invocation_id !== receipt.invocationId || admission.execution_id !== receipt.executionId) throw new Error('billing.tenant_mismatch');
    if (admission.status === 'captured') return this.toResult(admission);
    if (admission.status === 'released' || admission.status === 'rejected') throw new Error('billing.admission_not_active');
    const commandPayload = { admissionId, receipt, idempotencyKey: undefined };
    const prior = await this.beginReceipt(tenantId, 'internal', 'CaptureAdmission', idempotencyKey, commandPayload);
    if (prior !== null) return prior as BillingAdmissionResult;
    try {
      if (admission.hold_id === null) {
        const result = { ...this.toResult(admission), status: 'accepted_without_charge' as const };
        await this.markAdmission(tenantId, admissionId, 'captured', receipt);
        await this.finishReceipt(tenantId, 'internal', 'CaptureAdmission', idempotencyKey, result);
        return result;
      }
      const usageEventId = await this.usage.ensureUsageEventForHold({ tenantId: tenantId, holdId: admission.hold_id, sourceEventId: `admission:${admission.invocation_id}` });
      await this.usage.settleUsage({ tenantId: tenantId, holdId: admission.hold_id, usageEventId, actualMicros: readSafeInteger(admission.amount_micros, 'admission_amount_micros'), idempotencyKey: `capture:${admission.invocation_id}` });
      const result = { ...this.toResult(admission), status: 'accepted_without_charge' as const };
      await this.markAdmission(tenantId, admissionId, 'captured', receipt);
      await this.finishReceipt(tenantId, 'internal', 'CaptureAdmission', idempotencyKey, result);
      return result;
    } catch (error) {
      await this.failReceipt(tenantId, 'internal', 'CaptureAdmission', idempotencyKey, error);
      throw error;
    }
  }

  public async release(tenantId: string, admissionId: string, reason: string, idempotencyKey: string): Promise<BillingAdmissionResult> {
    const admission = await this.getAdmission(tenantId, admissionId);
    if (admission.status === 'released') return this.toResult(admission);
    if (admission.status === 'captured') throw new Error('billing.admission_not_active');
    const prior = await this.beginReceipt(tenantId, 'internal', 'ReleaseAdmission', idempotencyKey, { admissionId, reason });
    if (prior !== null) return prior as BillingAdmissionResult;
    try {
      if (admission.hold_id !== null) await this.usage.releaseUsage({ tenantId: tenantId, holdId: admission.hold_id, idempotencyKey: `release:${admission.invocation_id}` });
      await this.markAdmission(tenantId, admissionId, 'released');
      const result = this.toResult({ ...admission, status: 'released' });
      await this.finishReceipt(tenantId, 'internal', 'ReleaseAdmission', idempotencyKey, result);
      return result;
    } catch (error) {
      await this.failReceipt(tenantId, 'internal', 'ReleaseAdmission', idempotencyKey, error);
      throw error;
    }
  }

  public async recordExecutionEvent(input: ExecutionEventInput): Promise<{ readonly eventId: string; readonly status: 'received' | 'processed' }> {
    const payloadHash = createHash('sha256').update(stableJson(input)).digest('hex');
    await this.connection.execute(
      `INSERT INTO entitlement_execution_event
        (event_id, tenant_id, execution_id, invocation_id, event_type, occurred_at, receipt_schema_version, receipt_json, signature, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [input.eventId, input.tenantId, input.executionId, input.invocationId, input.eventType, input.occurredAt, input.receiptSchemaVersion, input.receipt ? JSON.stringify(input.receipt) : null, input.signature, payloadHash],
    );
    const [rows] = await this.connection.execute<RowDataPacket[]>('SELECT payload_hash, status FROM entitlement_execution_event WHERE tenant_id = $1 AND event_id = $2', [input.tenantId, input.eventId]);
    const row = rows[0] as { payload_hash: string; status: 'received' | 'processed' } | undefined;
    if (!row) throw new Error('billing.execution_event_not_found');
    if (row.payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
    return { eventId: input.eventId, status: row.status };
  }

  public async processExecutionEvent(tenantId: string, eventId: string): Promise<void> {
    const [events] = await this.connection.execute<RowDataPacket[]>('SELECT * FROM entitlement_execution_event WHERE tenant_id = $1 AND event_id = $2 FOR UPDATE', [tenantId, eventId]);
    const event = events[0] as (RowDataPacket & { event_type: ExecutionEventInput['eventType']; invocation_id: string; execution_id: string; receipt_json: string | null; receipt_schema_version: string; status: 'received' | 'processed' | 'failed' }) | undefined;
    if (!event || event.status === 'processed') return;
    const [admissions] = await this.connection.execute<AdmissionRow[]>('SELECT * FROM entitlement_billing_admission WHERE tenant_id = $1 AND invocation_id = $2 FOR UPDATE', [tenantId, event.invocation_id]);
    const admission = admissions[0];
    if (!admission) throw new Error('billing.admission_not_found');
    if (event.event_type === 'execution.accepted') {
      const parsedReceipt = event.receipt_json === null ? {} : JSON.parse(event.receipt_json) as Record<string, unknown>;
      const acceptedAt = typeof parsedReceipt.accepted_at === 'string' ? new Date(parsedReceipt.accepted_at) : new Date();
      await this.capture(tenantId, admission.admission_id, { invocationId: event.invocation_id, executionId: event.execution_id, acceptedProviderRef: String(parsedReceipt.provider_operation_ref ?? 'event'), acceptedAt, serviceReceipt: parsedReceipt, receiptSchemaVersion: event.receipt_schema_version }, `execution-event:${eventId}`);
    } else if (event.event_type === 'execution.rejected' || event.event_type === 'execution.failed') {
      await this.release(tenantId, admission.admission_id, event.event_type, `execution-event:${eventId}`);
    } else if (event.event_type === 'execution.unknown') {
      if (admission.status === 'held') await this.markAdmission(tenantId, admission.admission_id, 'unknown');
    }
    await this.connection.execute("UPDATE entitlement_execution_event SET status = 'processed', processed_at = CURRENT_TIMESTAMP(6) WHERE tenant_id = $1 AND event_id = $2 AND status = 'received'", [tenantId, eventId]);
  }

  private async ensureCreditAccount(tenantId: string, subjectRef: string): Promise<string> {
    const accountId = randomUUID();
    await this.connection.execute('INSERT INTO entitlement_credit_account (credit_account_id, tenant_id, subject_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [accountId, tenantId, subjectRef]);
    const [rows] = await this.connection.execute<RowDataPacket[]>('SELECT credit_account_id FROM entitlement_credit_account WHERE tenant_id = $1 AND subject_id = $2', [tenantId, subjectRef]);
    const row = rows[0] as { credit_account_id: string } | undefined;
    if (!row) throw new Error('billing.credit_account_not_found');
    return row.credit_account_id;
  }

  private async getAdmission(tenantId: string, admissionId: string): Promise<AdmissionRow> {
    const [rows] = await this.connection.execute<AdmissionRow[]>('SELECT * FROM entitlement_billing_admission WHERE tenant_id = $1 AND admission_id = $2', [tenantId, admissionId]);
    const row = rows[0];
    if (!row) throw new Error('billing.admission_not_found');
    return row;
  }

  private async markAdmission(tenantId: string, admissionId: string, status: AdmissionStatus, receipt?: AcceptedReceipt): Promise<void> {
    const current = await this.getAdmission(tenantId, admissionId);
    assertTransition('admission', current.status, status);
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE entitlement_billing_admission SET status = $1, accepted_provider_ref = COALESCE($2, accepted_provider_ref), accepted_at = COALESCE($3, accepted_at), service_receipt = COALESCE($4, service_receipt)
        WHERE tenant_id = $5 AND admission_id = $6 AND status = $7`,
      [status, receipt?.acceptedProviderRef ?? null, receipt?.acceptedAt ?? null, receipt ? JSON.stringify(receipt.serviceReceipt) : null, tenantId, admissionId, current.status],
    );
    if (result.affectedRows !== 1 && (await this.getAdmission(tenantId, admissionId)).status !== status) throw new Error('billing.admission_transition_conflict');
  }

  private toResult(row: Pick<AdmissionRow, 'admission_id' | 'hold_id' | 'mode' | 'price_policy_revision_id' | 'amount_micros' | 'status'>): BillingAdmissionResult {
    return { admissionId: row.admission_id, holdId: row.hold_id, mode: row.mode, pricePolicyRevisionId: row.price_policy_revision_id, amountMicros: String(row.amount_micros), currency: 'CRD', status: row.status === 'held' || row.status === 'unknown' ? 'held' : row.status === 'captured' ? 'accepted_without_charge' : 'rejected' };
  }

  private async beginReceipt(tenantId: string, surface: string, command: string, key: string, payload: unknown): Promise<unknown | null> {
    const hash = createHash('sha256').update(stableJson(payload)).digest('hex');
    await this.connection.beginTransaction();
    try {
      const [inserted] = await this.connection.execute<ResultSetHeader>('INSERT INTO entitlement_billing_command_receipt (receipt_id, tenant_id, api_surface, command_name, idempotency_key, payload_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', [randomUUID(), tenantId, surface, command, key, hash]);
      const [rows] = await this.connection.execute<ReceiptRow[]>('SELECT payload_hash, status, result_json FROM entitlement_billing_command_receipt WHERE tenant_id = $1 AND api_surface = $2 AND command_name = $3 AND idempotency_key = $4 FOR UPDATE', [tenantId, surface, command, key]);
      const row = rows[0];
      if (!row) throw new Error('billing.command_receipt_not_found');
      if (row.payload_hash !== hash) throw new Error('billing.idempotency_conflict');
      if (row.status === 'succeeded' && row.result_json !== null) { await this.connection.commit(); return typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json; }
      if (row.status === 'processing' && inserted.affectedRows !== 1) throw new Error('billing.command_in_progress');
      if (row.status === 'failed') throw new Error('billing.command_failed');
      if (row.status === 'unknown') throw new Error('billing.command_unknown');
      await this.connection.commit();
      return null;
    } catch (error) { await this.connection.rollback(); throw error; }
  }

  private async finishReceipt(tenantId: string, surface: string, command: string, key: string, result: unknown): Promise<void> {
    await this.connection.execute("UPDATE entitlement_billing_command_receipt SET status = 'succeeded', result_json = $1 WHERE tenant_id = $2 AND api_surface = $3 AND command_name = $4 AND idempotency_key = $5", [JSON.stringify(result), tenantId, surface, command, key]);
  }

  private async failReceipt(tenantId: string, surface: string, command: string, key: string, error: unknown): Promise<void> {
    await this.connection.execute("UPDATE entitlement_billing_command_receipt SET status = 'failed', result_json = $1 WHERE tenant_id = $2 AND api_surface = $3 AND command_name = $4 AND idempotency_key = $5", [JSON.stringify({ code: error instanceof Error ? error.message : 'billing.internal_error' }), tenantId, surface, command, key]);
  }
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}
