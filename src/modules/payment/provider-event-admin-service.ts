import { createHash, randomUUID } from 'node:crypto';
import type { Connection, RowDataPacket } from '../../../src/infrastructure/postgres/connection.js';

export type ProviderEventRetryInput = {
  readonly siteId: string;
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
type ProviderEventCursor = { readonly receivedAt: string; readonly providerEventId: string };

/** Operational retry is a durable command, not an in-memory worker poke. */
export class ProviderEventAdminService {
  public constructor(private readonly connection: Connection) {}

  public async list(input: { readonly siteId: string; readonly status?: ProviderEventRetryResult['processingStatus']; readonly limit?: number; readonly cursor?: string }): Promise<{ readonly items: readonly ProviderEventListItem[]; readonly nextCursor?: string }> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
    const cursor = input.cursor === undefined ? undefined : decodeProviderEventCursor(input.cursor);
    const statusPredicate = input.status === undefined ? '' : 'AND processing_status = ?';
    const cursorPredicate = cursor === undefined ? '' : 'AND (received_at < ? OR (received_at = ? AND provider_event_id < ?))';
    const args = [input.siteId, ...(input.status === undefined ? [] : [input.status]), ...(cursor === undefined ? [] : [new Date(cursor.receivedAt), new Date(cursor.receivedAt), cursor.providerEventId]), limit + 1];
    const [rows] = await this.connection.query<EventListRow[]>(
      `SELECT provider_event_id, provider, external_event_id, event_type, processing_status, processing_attempts, last_error, received_at, processed_at
         FROM payment_provider_event
        WHERE tenant_id = $1 ${statusPredicate} ${cursorPredicate}
        ORDER BY received_at DESC, provider_event_id DESC LIMIT $2`,
      args,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => ({ providerEventId: String(row.provider_event_id), provider: String(row.provider), externalEventId: String(row.external_event_id), eventType: String(row.event_type), processingStatus: row.processing_status, processingAttempts: Number(row.processing_attempts), lastError: row.last_error === null ? null : String(row.last_error), receivedAt: new Date(row.received_at).toISOString(), processedAt: row.processed_at === null ? null : new Date(row.processed_at).toISOString() }));
    if (!hasMore || page.length === 0) return { items };
    const last = items[items.length - 1]!;
    return { items, nextCursor: encodeProviderEventCursor({ receivedAt: last.receivedAt, providerEventId: last.providerEventId }) };
  }

  public async retry(input: ProviderEventRetryInput): Promise<ProviderEventRetryResult> {
    if (input.reason.trim() === '') throw new Error('billing.admin_reason_required');
    const payloadHash = createHash('sha256').update(JSON.stringify({ providerEventId: input.providerEventId, reason: input.reason })).digest('hex');
    await this.connection.beginTransaction();
    try {
      const [prior] = await this.connection.execute<ReceiptRow[]>(
        `SELECT payload_hash, status, result_json FROM payment_command_receipt
          WHERE tenant_id = $1 AND command_name = 'ProviderEventRetry' AND idempotency_key = $2 FOR UPDATE`,
        [input.siteId, input.idempotencyKey],
      );
      if (prior[0]) {
        if (prior[0].payload_hash !== payloadHash) throw new Error('billing.idempotency_conflict');
        if (prior[0].status === 'processing') throw new Error('billing.command_in_progress');
        if (prior[0].status === 'unknown') throw new Error('billing.command_unknown');
        if (!prior[0].result_json) throw new Error('billing.command_failed');
        const result = typeof prior[0].result_json === 'string' ? JSON.parse(prior[0].result_json) as ProviderEventRetryResult : prior[0].result_json;
        await this.connection.commit();
        return result;
      }
      const receiptId = randomUUID();
      await this.connection.execute(
        `INSERT INTO payment_command_receipt
          (receipt_id, tenant_id, command_name, idempotency_key, payload_hash, status)
         VALUES ($1, $2, 'ProviderEventRetry', $3, $4, 'processing')`,
        [receiptId, input.siteId, input.idempotencyKey, payloadHash],
      );
      const [events] = await this.connection.execute<EventRow[]>(
        `SELECT provider_event_id, processing_status FROM payment_provider_event
          WHERE tenant_id = $1 AND provider_event_id = $2 FOR UPDATE`,
        [input.siteId, input.providerEventId],
      );
      const event = events[0];
      if (!event) throw new Error('billing.provider_event_not_found');
      let result: ProviderEventRetryResult = { providerEventId: event.provider_event_id, processingStatus: event.processing_status };
      if (event.processing_status === 'failed' || event.processing_status === 'received') {
        await this.connection.execute(
          `UPDATE payment_provider_event
              SET processing_status = 'received', processed_at = NULL, last_error = NULL
            WHERE tenant_id = $1 AND provider_event_id = $2`,
          [input.siteId, event.provider_event_id],
        );
        await this.connection.execute(
          `INSERT INTO payment_outbox
            (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
           SELECT $1, tenant_id, 'provider_event', provider_event_id, 'PaymentProviderEventReceived', $2
             FROM payment_provider_event WHERE tenant_id = $3 AND provider_event_id = $4
           ON CONFLICT (aggregate_type, aggregate_id, event_type) DO UPDATE SET published_at = NULL, dead_lettered_at = NULL, attempts = 0, next_attempt_at = CURRENT_TIMESTAMP(6), lease_token = NULL, lease_until = NULL`,
          [randomUUID(), JSON.stringify({ providerEventId: event.provider_event_id }), input.siteId, event.provider_event_id],
        );
        result = { providerEventId: event.provider_event_id, processingStatus: 'received' };
      }
      await this.connection.execute(
        `UPDATE payment_command_receipt SET status = 'succeeded', result_json = $1 WHERE tenant_id = $2 AND receipt_id = $3`,
        [JSON.stringify(result), input.siteId, receiptId],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_audit_event
          (audit_event_id, tenant_id, operator_id, action, resource_type, resource_id, reason, payload_json)
         VALUES ($1, $2, $3, 'provider_event_retry', 'payment_provider_event', $4, $5, $6)`,
        [randomUUID(), input.siteId, input.operatorId, input.providerEventId, input.reason, JSON.stringify({ idempotencyKey: input.idempotencyKey })],
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

function decodeProviderEventCursor(value: string): ProviderEventCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (typeof cursor.receivedAt !== 'string' || cursor.receivedAt.length === 0 || Number.isNaN(Date.parse(cursor.receivedAt)) || typeof cursor.providerEventId !== 'string' || cursor.providerEventId.length === 0) throw new Error();
    return { receivedAt: cursor.receivedAt, providerEventId: cursor.providerEventId };
  } catch {
    throw new Error('billing.invalid_cursor');
  }
}
