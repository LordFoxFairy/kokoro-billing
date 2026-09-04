import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, RowDataPacket } from '../../database.js';
import { z } from 'zod';
import { parsePersistedJson } from '../../json.js';

export type ProviderEventRetryInput = {
  readonly tenantId: string;
  readonly providerEventId: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
};

export type ProviderEventRetryResult = {
  readonly providerEventId: string;
  readonly processingStatus: 'received' | 'processed' | 'ignored' | 'failed';
};
export type ProviderEventListItem = {
  readonly providerEventId: string;
  readonly provider: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly processingStatus: ProviderEventRetryResult['processingStatus'];
  readonly processingAttempts: number;
  readonly lastError: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
};

type ReceiptRow = RowDataPacket & { payload_hash: string; status: string; result_json: string | ProviderEventRetryResult | null };
type EventRow = RowDataPacket & { provider_event_id: string; processing_status: ProviderEventRetryResult['processingStatus'] };
type EventListRow = RowDataPacket & { provider_event_id: string; provider: string; external_event_id: string; event_type: string; processing_status: ProviderEventRetryResult['processingStatus']; processing_attempts: number; last_error: string | null; received_at: Date | string; processed_at: Date | string | null };
type ProviderEventCursor = { readonly version: 1; readonly scope: 'payment.provider-event.admin'; readonly tenantId: string; readonly status: ProviderEventRetryResult['processingStatus'] | null; readonly receivedAt: string; readonly providerEventId: string };
const providerEventRetryResultSchema = z.object({ providerEventId: z.string().min(1), processingStatus: z.enum(['received', 'processed', 'ignored', 'failed']) }).strict();
const providerEventCursorSchema = z.object({
  version: z.literal(1), scope: z.literal('payment.provider-event.admin'), tenantId: z.string().min(1),
  status: z.enum(['received', 'processed', 'ignored', 'failed']).nullable(),
  receivedAt: z.string().datetime({ offset: true }), providerEventId: z.string().min(1),
}).strict();

/** Operational retry is a durable command, not an in-memory worker poke. */
export class ProviderEventAdminService {
  public constructor(private readonly connection: SqlConnection) {}

  public async list(input: { readonly tenantId: string; readonly status?: ProviderEventRetryResult['processingStatus']; readonly limit?: number; readonly cursor?: string }): Promise<{ readonly items: readonly ProviderEventListItem[]; readonly nextCursor?: string }> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
    const cursor = input.cursor === undefined ? undefined : decodeProviderEventCursor(input.cursor, input.tenantId, input.status ?? null);
    const statusPredicate = input.status === undefined ? '' : 'AND processing_status = $2';
    const cursorOffset = input.status === undefined ? 2 : 3;
    const cursorPredicate = cursor === undefined ? '' : `AND (received_at < $${cursorOffset} OR (received_at = $${cursorOffset + 1} AND provider_event_id < $${cursorOffset + 2}))`;
    const limitPlaceholder = cursor === undefined ? (input.status === undefined ? '$2' : '$3') : `$${cursorOffset + 3}`;
    const args = [input.tenantId, ...(input.status === undefined ? [] : [input.status]), ...(cursor === undefined ? [] : [new Date(cursor.receivedAt), new Date(cursor.receivedAt), cursor.providerEventId]), limit + 1];
    const [rows] = await this.connection.query<EventListRow[]>(
      `SELECT provider_event_id, provider, external_event_id, event_type, processing_status, processing_attempts, last_error, received_at, processed_at
         FROM payment_provider_event
        WHERE tenant_id = $1 ${statusPredicate} ${cursorPredicate}
        ORDER BY received_at DESC, provider_event_id DESC LIMIT ${limitPlaceholder}`,
      args,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => ({ providerEventId: String(row.provider_event_id), provider: String(row.provider), externalEventId: String(row.external_event_id), eventType: String(row.event_type), processingStatus: row.processing_status, processingAttempts: Number(row.processing_attempts), lastError: row.last_error === null ? null : String(row.last_error), receivedAt: new Date(row.received_at).toISOString(), processedAt: row.processed_at === null ? null : new Date(row.processed_at).toISOString() }));
    if (!hasMore || page.length === 0) return { items };
    const last = items.at(-1);
    if (last === undefined) return { items };
    return { items, nextCursor: encodeProviderEventCursor({ version: 1, scope: 'payment.provider-event.admin', tenantId: input.tenantId, status: input.status ?? null, receivedAt: last.receivedAt, providerEventId: last.providerEventId }) };
  }

  public async retry(input: ProviderEventRetryInput): Promise<ProviderEventRetryResult> {
    if (input.reason.trim() === '') throw new Error('billing.admin_reason_required');
    const payloadHash = createHash('sha256').update(JSON.stringify({ providerEventId: input.providerEventId, reason: input.reason })).digest('hex');
    await this.connection.beginTransaction();
    try {
      const [prior] = await this.connection.execute<ReceiptRow[]>(
        `SELECT payload_hash, status, result_json FROM payment_command_receipt
          WHERE tenant_id = $1 AND command_name = 'ProviderEventRetry' AND idempotency_key = $2 FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior[0]) {
        if (prior[0].payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
        if (prior[0].status === 'processing' || prior[0].status === 'unknown') throw new Error('billing.command_unknown');
        if (prior[0].status === 'failed') throw new Error('billing.command_failed');
        if (prior[0].status !== 'succeeded') throw new Error('billing.command_unknown');
        const result = parsePersistedJson(prior[0].result_json, providerEventRetryResultSchema, 'billing.command_result_invalid');
        await this.connection.commit();
        return result;
      }
      const receiptId = randomUUID();
      await this.connection.execute(
        `INSERT INTO payment_command_receipt
          (receipt_id, tenant_id, command_name, idempotency_key, payload_hash, status)
         VALUES ($1, $2, 'ProviderEventRetry', $3, $4, 'processing')`,
        [receiptId, input.tenantId, input.idempotencyKey, payloadHash],
      );
      const [events] = await this.connection.execute<EventRow[]>(
        `SELECT provider_event_id, processing_status FROM payment_provider_event
          WHERE tenant_id = $1 AND provider_event_id = $2 FOR UPDATE`,
        [input.tenantId, input.providerEventId],
      );
      const event = events[0];
      if (!event) throw new Error('billing.provider_event_not_found');
      let result: ProviderEventRetryResult = { providerEventId: event.provider_event_id, processingStatus: event.processing_status };
      if (event.processing_status === 'failed' || event.processing_status === 'received') {
        await this.connection.execute(
          `UPDATE payment_provider_event
              SET processing_status = 'received', processed_at = NULL, last_error = NULL
            WHERE tenant_id = $1 AND provider_event_id = $2`,
          [input.tenantId, event.provider_event_id],
        );
        await this.connection.execute(
          `INSERT INTO payment_outbox
            (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
           SELECT $1, tenant_id, 'provider_event', provider_event_id, 'PaymentProviderEventReceived', $2
             FROM payment_provider_event WHERE tenant_id = $3 AND provider_event_id = $4
           ON CONFLICT (aggregate_type, aggregate_id, event_type) DO UPDATE SET published_at = NULL, dead_lettered_at = NULL, attempts = 0, next_attempt_at = CURRENT_TIMESTAMP(3), lease_token = NULL, lease_until = NULL`,
          [randomUUID(), JSON.stringify({ providerEventId: event.provider_event_id }), input.tenantId, event.provider_event_id],
        );
        result = { providerEventId: event.provider_event_id, processingStatus: 'received' };
      }
      await this.connection.execute(
        `UPDATE payment_command_receipt SET status = 'succeeded', result_json = $1 WHERE tenant_id = $2 AND receipt_id = $3`,
        [JSON.stringify(result), input.tenantId, receiptId],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_audit_event
          (audit_event_id, tenant_id, operator_id, action, resource_type, resource_id, reason, payload_json)
         VALUES ($1, $2, $3, 'provider_event_retry', 'payment_provider_event', $4, $5, $6)`,
        [randomUUID(), input.tenantId, input.operatorId, input.providerEventId, input.reason, JSON.stringify({ idempotencyKey: input.idempotencyKey })],
      );
      await this.connection.commit();
      return result;
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}

function encodeProviderEventCursor(cursor: ProviderEventCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeProviderEventCursor(value: string, tenantId: string, status: ProviderEventRetryResult['processingStatus'] | null): ProviderEventCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const result = providerEventCursorSchema.safeParse(parsed);
    if (!result.success || result.data.tenantId !== tenantId || result.data.status !== status) throw new Error();
    return result.data;
  } catch {
    throw new Error('billing.invalid_cursor');
  }
}
