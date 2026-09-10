import { createHash, randomUUID } from "node:crypto";
import type { SqlConnection, RowDataPacket } from "../../database.js";

export type ProviderEventInput = {
  readonly tenantId: string;
  readonly provider: string;
  readonly providerAccountRef?: string | null;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly rawPayload: unknown;
  readonly signatureValid: boolean;
};

export type ProviderEventFact = {
  readonly providerEventId: string;
  readonly processingStatus: "received" | "processed" | "ignored" | "failed";
};

type ProviderEventRow = RowDataPacket & {
  provider_event_id: string;
  provider_account_ref: string | null;
  processing_status: "received" | "processed" | "ignored" | "failed";
  payload_hash: string;
  event_type: string;
};

export class ProviderEventInboxService {
  public constructor(private readonly connection: SqlConnection) {}

  public async accept(input: ProviderEventInput): Promise<ProviderEventFact> {
    if (!input.signatureValid) throw new Error("billing.provider_signature");
    const providerEventId = randomUUID();
    const payloadJson = JSON.stringify(input.rawPayload);
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
    await this.connection.beginTransaction();
    try {
      await this.connection.execute(
        `INSERT INTO payment_provider_event
          (provider_event_id, tenant_id, provider, provider_account_ref, external_event_id, event_type, payload_json, payload_hash, signature_valid, processing_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, 'received')
         ON CONFLICT DO NOTHING`,
        [
          providerEventId,
          input.tenantId,
          input.provider,
          input.providerAccountRef ?? null,
          input.externalEventId,
          input.eventType,
          payloadJson,
          payloadHash,
        ],
      );
      const [rows] = await this.connection.execute<ProviderEventRow[]>(
        `SELECT provider_event_id, provider_account_ref, processing_status, payload_hash, event_type
           FROM payment_provider_event
          WHERE tenant_id = $1 AND provider = $2 AND external_event_id = $3 FOR UPDATE`,
        [input.tenantId, input.provider, input.externalEventId],
      );
      const row = rows[0];
      if (!row) throw new Error("billing.provider_event_not_found");
      if (
        row.payload_hash !== payloadHash ||
        row.event_type !== input.eventType ||
        row.provider_account_ref !== (input.providerAccountRef ?? null)
      )
        throw new Error("billing.idempotency_conflict");
      await this.connection.execute(
        `INSERT INTO payment_outbox
          (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'provider_event', $3, 'PaymentProviderEventReceived', $4)
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          input.tenantId,
          row.provider_event_id,
          JSON.stringify({
            providerEventId: row.provider_event_id,
            provider: input.provider,
            externalEventId: input.externalEventId,
            eventType: input.eventType,
          }),
        ],
      );
      await this.connection.commit();
      return {
        providerEventId: row.provider_event_id,
        processingStatus: row.processing_status,
      };
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }
}
