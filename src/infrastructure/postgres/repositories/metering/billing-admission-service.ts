import { randomUUID } from 'node:crypto';
import { z, type ZodType } from 'zod';
import type { SqlConnection, ResultSetHeader, RowDataPacket } from '../../database.js';
import type { UsageSettlementService } from './usage-settlement-service.js';
import { readSafeInteger } from '../../../../application/ports/safe-integer.js';
import type {
  AcceptedReceipt,
  BillingAdmissionResult,
  CreateBillingAdmissionInput,
  ExecutionEventInput,
  ReleaseAdmissionInput,
} from '../../../../application/metering/services/billing-admission-service.js';
import { jsonRecordSchema, parsePersistedJson, PersistedDataInvariantError } from '../../json.js';
import { canonicalJson, canonicalJsonDigest } from '../../canonical-json.js';
import { assertTransition, type AdmissionStatus } from '../../../../domain/payment/services/billing-state-machine.js';

type AdmissionRow = RowDataPacket & {
  admission_id: string; tenant_id: string; invocation_id: string; execution_id: string;
  feature_key: string; billing_subject_kind: string; billing_subject_ref: string; payer_ref: string;
  surface: string; meter_kind: string; requested_model_tier: string | null;
  price_policy_revision_id: string | null; amount_micros: string | number; mode: 'included' | 'credit' | 'payg' | 'rejected';
  status: AdmissionStatus; hold_id: string | null; accepted_provider_ref: string | null; accepted_at: Date | string | null;
};
type ReceiptRow = RowDataPacket & {
  receipt_id: string;
  command_identity: string | null;
  payload_hash: string;
  status: 'processing' | 'succeeded' | 'failed' | 'unknown';
  result_json: unknown;
};
type ReceiptClaim<T> = { readonly kind: 'claimed'; readonly receiptId: string } | { readonly kind: 'replay'; readonly result: T };

const admissionResultSchema = z.object({
  admissionId: z.string().min(1),
  holdId: z.string().min(1).nullable(),
  mode: z.enum(['included', 'credit', 'payg', 'rejected']),
  pricePolicyRevisionId: z.string().min(1).nullable(),
  amountMicros: z.string().regex(/^\d+$/u),
  currency: z.literal('CRD'),
  status: z.enum(['held', 'accepted_without_charge', 'rejected']),
}).strict();
const executionEventResultSchema = z.object({
  eventId: z.string().min(1),
  status: z.enum(['received', 'processed']),
}).strict();

const AUTHORIZE_COMMAND = 'AuthorizeAdmission';
const CAPTURE_COMMAND = 'CaptureAdmission';
const RELEASE_COMMAND = 'ReleaseAdmission';
const EXECUTION_EVENT_COMMAND = 'RecordExecutionEvent';

/** The single application service for the target invocation billing loop. */
export class BillingAdmissionService {
  public constructor(private readonly connection: SqlConnection, private readonly usage: Pick<UsageSettlementService, 'authorizeUsage' | 'settleUsage' | 'releaseUsage' | 'ensureUsageEventForHold'>) {}

  public async create(input: CreateBillingAdmissionInput): Promise<BillingAdmissionResult> {
    const claim = await this.claimReceipt(
      input.tenantId,
      'internal',
      AUTHORIZE_COMMAND,
      input.invocationId,
      input.idempotencyKey,
      {
        command: 'entitlement.admission.authorize/v1',
        billingSubject: input.billingSubject,
        payerRef: input.payerRef,
        featureKey: input.featureKey,
        surface: input.surface,
        invocationId: input.invocationId,
        executionId: input.executionId,
        meterKind: input.meterKind,
        requestedModelTier: input.requestedModelTier ?? null,
      },
      admissionResultSchema,
    );
    if (claim.kind === 'replay') return claim.result;
    const [existingRows] = await this.connection.execute<AdmissionRow[]>(
      `SELECT admission_id, tenant_id, invocation_id, execution_id, feature_key,
              billing_subject_kind, billing_subject_ref, payer_ref, surface, meter_kind,
              requested_model_tier, price_policy_revision_id, amount_micros, mode, status,
              hold_id, accepted_provider_ref, accepted_at
         FROM entitlement_billing_admission
        WHERE tenant_id = $1 AND invocation_id = $2
        FOR UPDATE`,
      [input.tenantId, input.invocationId],
    );
    const existing = existingRows[0];
    if (existing) {
      if (existing.billing_subject_kind !== input.billingSubject.kind
        || existing.billing_subject_ref !== input.billingSubject.ref
        || existing.payer_ref !== input.payerRef
        || existing.feature_key !== input.featureKey
        || existing.surface !== input.surface
        || existing.execution_id !== input.executionId
        || existing.meter_kind !== input.meterKind
        || existing.requested_model_tier !== (input.requestedModelTier ?? null)) {
        throw new Error('billing.idempotency_conflict');
      }
      const result = this.toResult(existing);
      await this.finishReceipt(claim.receiptId, input.tenantId, AUTHORIZE_COMMAND, result);
      return result;
    }

    const [rates] = await this.connection.execute<(RowDataPacket & { usage_price_revision_id: string; reservation_micros: string | number })[]>(
      `SELECT r.usage_price_revision_id, r.reservation_micros
         FROM entitlement_usage_price_rate r
         INNER JOIN entitlement_usage_price_revision p
           ON p.usage_price_revision_id = r.usage_price_revision_id AND p.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.feature_key = $2 AND r.label_key IS NULL AND r.status = 'active'
          AND p.status = 'published' AND p.effective_from <= CURRENT_TIMESTAMP(3)
          AND (p.effective_to IS NULL OR p.effective_to > CURRENT_TIMESTAMP(3))
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
      await this.finishReceipt(claim.receiptId, input.tenantId, AUTHORIZE_COMMAND, accepted);
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
    await this.finishReceipt(claim.receiptId, input.tenantId, AUTHORIZE_COMMAND, result);
    return result;
  }

  public async capture(tenantId: string, admissionId: string, receipt: AcceptedReceipt, idempotencyKey: string): Promise<BillingAdmissionResult> {
    if (Number.isNaN(receipt.acceptedAt.getTime())) throw new Error('billing.invalid_request');
    const claim = await this.claimReceipt(
      tenantId,
      'internal',
      CAPTURE_COMMAND,
      admissionId,
      idempotencyKey,
      {
        command: 'entitlement.admission.capture/v1',
        admissionId,
        invocationId: receipt.invocationId,
        executionId: receipt.executionId,
        acceptedProviderRef: receipt.acceptedProviderRef,
        acceptedAt: receipt.acceptedAt.toISOString(),
        serviceReceipt: receipt.serviceReceipt,
        receiptSchemaVersion: receipt.receiptSchemaVersion,
      },
      admissionResultSchema,
    );
    if (claim.kind === 'replay') return claim.result;

    const admission = await this.getAdmission(tenantId, admissionId);
    if (admission.invocation_id !== receipt.invocationId || admission.execution_id !== receipt.executionId) throw new Error('billing.tenant_mismatch');
    if (admission.status === 'captured') {
      const result = { ...this.toResult(admission), status: 'accepted_without_charge' as const };
      await this.finishReceipt(claim.receiptId, tenantId, CAPTURE_COMMAND, result);
      return result;
    }
    if (admission.status === 'released' || admission.status === 'rejected') throw new Error('billing.admission_not_active');
    if (admission.hold_id !== null) {
      const usageEventId = await this.usage.ensureUsageEventForHold({ tenantId, holdId: admission.hold_id, sourceEventId: `admission:${admission.invocation_id}` });
      await this.usage.settleUsage({ tenantId, holdId: admission.hold_id, usageEventId, actualMicros: readSafeInteger(admission.amount_micros, 'admission_amount_micros'), idempotencyKey: `capture:${admission.invocation_id}` });
    }
    const result = { ...this.toResult(admission), status: 'accepted_without_charge' as const };
    await this.markAdmission(tenantId, admissionId, 'captured', receipt);
    await this.finishReceipt(claim.receiptId, tenantId, CAPTURE_COMMAND, result);
    return result;
  }

  public async release(input: ReleaseAdmissionInput): Promise<BillingAdmissionResult> {
    const claim = await this.claimReceipt(
      input.tenantId,
      'internal',
      RELEASE_COMMAND,
      input.admissionId,
      input.idempotencyKey,
      {
        command: 'entitlement.admission.release/v1',
        admissionId: input.admissionId,
        invocationId: input.invocationId,
        reason: input.reason,
        serviceReceipt: input.serviceReceipt ?? null,
      },
      admissionResultSchema,
    );
    if (claim.kind === 'replay') return claim.result;

    const admission = await this.getAdmission(input.tenantId, input.admissionId);
    if (admission.invocation_id !== input.invocationId) throw new Error('billing.tenant_mismatch');
    if (admission.status === 'released') {
      const result = this.toResult(admission);
      await this.finishReceipt(claim.receiptId, input.tenantId, RELEASE_COMMAND, result);
      return result;
    }
    if (admission.status === 'captured') throw new Error('billing.admission_not_active');
    if (admission.hold_id !== null) await this.usage.releaseUsage({ tenantId: input.tenantId, holdId: admission.hold_id, idempotencyKey: `release:${admission.invocation_id}` });
    await this.markAdmission(input.tenantId, input.admissionId, 'released');
    const result = this.toResult({ ...admission, status: 'released' });
    await this.finishReceipt(claim.receiptId, input.tenantId, RELEASE_COMMAND, result);
    return result;
  }

  public async recordExecutionEvent(input: ExecutionEventInput): Promise<{ readonly eventId: string; readonly status: 'received' | 'processed' }> {
    if (Number.isNaN(input.occurredAt.getTime())) throw new Error('billing.invalid_request');
    const commandPayload = {
      command: 'billing.execution-event.record/v1',
      eventId: input.eventId,
      eventType: input.eventType,
      executionId: input.executionId,
      invocationId: input.invocationId,
      occurredAt: input.occurredAt.toISOString(),
      receiptSchemaVersion: input.receiptSchemaVersion,
      receipt: input.receipt ?? null,
    };
    const payloadHash = canonicalJsonDigest(commandPayload);
    const claim = await this.claimReceipt(
      input.tenantId,
      'internal',
      EXECUTION_EVENT_COMMAND,
      input.eventId,
      input.idempotencyKey,
      commandPayload,
      executionEventResultSchema,
    );
    if (claim.kind === 'replay') return claim.result;

    await this.connection.execute(
      `INSERT INTO entitlement_execution_event
        (event_id, tenant_id, execution_id, invocation_id, event_type, occurred_at, receipt_schema_version, receipt_json, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [input.eventId, input.tenantId, input.executionId, input.invocationId, input.eventType, input.occurredAt, input.receiptSchemaVersion, input.receipt === undefined ? null : canonicalJson(input.receipt), payloadHash],
    );
    const [rows] = await this.connection.execute<(RowDataPacket & { payload_hash: string; status: 'received' | 'processed' | 'failed' })[]>(
      'SELECT payload_hash, status FROM entitlement_execution_event WHERE tenant_id = $1 AND event_id = $2 FOR UPDATE',
      [input.tenantId, input.eventId],
    );
    const row = rows[0];
    if (!row) throw new PersistedDataInvariantError('billing.execution_event_not_found_after_insert');
    if (row.payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
    if (row.status === 'failed') throw new Error('billing.command_failed');
    const result = { eventId: input.eventId, status: row.status };
    await this.finishReceipt(claim.receiptId, input.tenantId, EXECUTION_EVENT_COMMAND, result);
    return result;
  }

  public async processExecutionEvent(tenantId: string, eventId: string): Promise<void> {
    const [events] = await this.connection.execute<RowDataPacket[]>(`SELECT event_id, tenant_id, execution_id, invocation_id, event_type,
                occurred_at, receipt_schema_version, receipt_json, status
           FROM entitlement_execution_event
          WHERE tenant_id = $1 AND event_id = $2
          FOR UPDATE`, [tenantId, eventId]);
    const event = events[0] as (RowDataPacket & { event_type: ExecutionEventInput['eventType']; invocation_id: string; execution_id: string; occurred_at: Date | string; receipt_json: string | null; receipt_schema_version: string; status: 'received' | 'processed' | 'failed' }) | undefined;
    if (!event || event.status === 'processed') return;
    const [admissions] = await this.connection.execute<AdmissionRow[]>(`SELECT admission_id, tenant_id, invocation_id, execution_id, feature_key,
                billing_subject_kind, billing_subject_ref, payer_ref, surface, meter_kind,
                requested_model_tier, price_policy_revision_id, amount_micros, mode, status,
                hold_id, accepted_provider_ref, accepted_at
           FROM entitlement_billing_admission
          WHERE tenant_id = $1 AND invocation_id = $2`, [tenantId, event.invocation_id]);
    const admission = admissions[0];
    if (!admission) throw new Error('billing.admission_not_found');
    if (event.event_type === 'execution.accepted') {
      const parsedReceipt = event.receipt_json === null ? {} : parsePersistedJson(event.receipt_json, jsonRecordSchema, 'billing.execution_receipt_invalid');
      const acceptedAt = typeof parsedReceipt.accepted_at === 'string' ? new Date(parsedReceipt.accepted_at) : new Date(event.occurred_at);
      await this.capture(tenantId, admission.admission_id, { invocationId: event.invocation_id, executionId: event.execution_id, acceptedProviderRef: String(parsedReceipt.provider_operation_ref ?? 'event'), acceptedAt, serviceReceipt: parsedReceipt, receiptSchemaVersion: event.receipt_schema_version }, `execution-event:${eventId}`);
    } else if (event.event_type === 'execution.rejected' || event.event_type === 'execution.failed') {
      const serviceReceipt = event.receipt_json === null ? undefined : parsePersistedJson(event.receipt_json, jsonRecordSchema, 'billing.execution_receipt_invalid');
      await this.release({
        tenantId,
        admissionId: admission.admission_id,
        invocationId: event.invocation_id,
        reason: event.event_type,
        ...(serviceReceipt === undefined ? {} : { serviceReceipt }),
        idempotencyKey: `execution-event:${eventId}`,
      });
    } else if (event.event_type === 'execution.unknown') {
      const lockedAdmission = await this.getAdmission(tenantId, admission.admission_id);
      if (lockedAdmission.status === 'held') await this.markAdmission(tenantId, admission.admission_id, 'unknown');
    }
    await this.connection.execute("UPDATE entitlement_execution_event SET status = 'processed', processed_at = CURRENT_TIMESTAMP(3) WHERE tenant_id = $1 AND event_id = $2 AND status = 'received'", [tenantId, eventId]);
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
    const [rows] = await this.connection.execute<AdmissionRow[]>(`SELECT admission_id, tenant_id, invocation_id, execution_id, feature_key,
                billing_subject_kind, billing_subject_ref, payer_ref, surface, meter_kind,
                requested_model_tier, price_policy_revision_id, amount_micros, mode, status,
                hold_id, accepted_provider_ref, accepted_at
           FROM entitlement_billing_admission
          WHERE tenant_id = $1 AND admission_id = $2
          FOR UPDATE`, [tenantId, admissionId]);
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
      [status, receipt?.acceptedProviderRef ?? null, receipt?.acceptedAt ?? null, receipt ? canonicalJson(receipt.serviceReceipt) : null, tenantId, admissionId, current.status],
    );
    if (result.affectedRows !== 1 && (await this.getAdmission(tenantId, admissionId)).status !== status) throw new Error('billing.admission_transition_conflict');
  }

  private toResult(row: Pick<AdmissionRow, 'admission_id' | 'hold_id' | 'mode' | 'price_policy_revision_id' | 'amount_micros' | 'status'>): BillingAdmissionResult {
    return { admissionId: row.admission_id, holdId: row.hold_id, mode: row.mode, pricePolicyRevisionId: row.price_policy_revision_id, amountMicros: String(row.amount_micros), currency: 'CRD', status: row.status === 'held' || row.status === 'unknown' ? 'held' : row.status === 'captured' ? 'accepted_without_charge' : 'rejected' };
  }

  private async claimReceipt<T>(
    tenantId: string,
    surface: string,
    command: string,
    identity: string,
    key: string,
    payload: unknown,
    resultSchema: ZodType<T>,
  ): Promise<ReceiptClaim<T>> {
    const hash = canonicalJsonDigest(payload);
    const [inserted] = await this.connection.execute<ResultSetHeader>(
      `INSERT INTO entitlement_billing_command_receipt
        (receipt_id, tenant_id, api_surface, command_name, command_identity, idempotency_key, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, surface, command, identity, key, hash],
    );
    const [rows] = await this.connection.execute<ReceiptRow[]>(
      `SELECT receipt_id, command_identity, payload_hash, status, result_json
         FROM entitlement_billing_command_receipt
        WHERE tenant_id = $1 AND api_surface = $2 AND command_name = $3
          AND (idempotency_key = $4 OR command_identity = $5)
        FOR UPDATE`,
      [tenantId, surface, command, key, identity],
    );
    if (rows.length !== 1) throw new Error('billing.idempotency_conflict');
    const row = rows[0];
    if (!row) throw new PersistedDataInvariantError('billing.command_receipt_not_found_after_insert');
    if (row.payload_hash !== hash || row.command_identity !== identity) throw new Error('billing.idempotency_conflict');
    if (row.status === 'succeeded') {
      return { kind: 'replay', result: parsePersistedJson(row.result_json, resultSchema, 'billing.command_result_invalid') };
    }
    if (row.status === 'failed') throw new Error('billing.command_failed');
    if (row.status === 'unknown' || inserted.affectedRows !== 1) throw new Error('billing.command_unknown');
    return { kind: 'claimed', receiptId: row.receipt_id };
  }

  private async finishReceipt(receiptId: string, tenantId: string, command: string, result: unknown): Promise<void> {
    const [updated] = await this.connection.execute<ResultSetHeader>(
      `UPDATE entitlement_billing_command_receipt
          SET status = 'succeeded', result_json = $1, updated_at = CURRENT_TIMESTAMP(3)
        WHERE receipt_id = $2 AND tenant_id = $3 AND command_name = $4 AND status = 'processing'`,
      [canonicalJson(result), receiptId, tenantId, command],
    );
    if (updated.affectedRows !== 1) throw new PersistedDataInvariantError('billing.command_receipt_transition_invalid');
  }
}
