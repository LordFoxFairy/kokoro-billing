import { randomUUID } from "node:crypto";
import type {
  ResultSetHeader,
  RowDataPacket,
  SqlConnection,
} from "./database.js";
import { jsonRecordSchema, parsePersistedJson } from "./json.js";

type OutboxTable = "entitlement_outbox" | "payment_outbox";
type OutboxRow = RowDataPacket & {
  outbox_id: string;
  event_type: string;
  payload_json: unknown;
  attempts: number;
};
export type OutboxProcessResult =
  false | "published" | "retrying" | "dead_lettered" | "lease_lost";

export class OutboxWorker {
  private readonly leaseConnection: SqlConnection;

  public constructor(
    private readonly connection: SqlConnection,
    private readonly table: OutboxTable,
    private readonly leaseSeconds = 30,
    private readonly eventType?: string,
    private readonly maxAttempts = 10,
    private readonly tenantId?: string,
    leaseConnection?: SqlConnection,
  ) {
    this.leaseConnection = leaseConnection ?? connection;
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0)
      throw new RangeError(
        "outbox lease seconds must be a positive safe integer",
      );
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0)
      throw new RangeError(
        "outbox max attempts must be a positive safe integer",
      );
  }

  public async processOnce(
    handler: (event: {
      readonly outboxId: string;
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
    }) => Promise<void>,
  ): Promise<OutboxProcessResult> {
    const leaseToken = randomUUID();
    await this.connection.beginTransaction();
    let row: OutboxRow | undefined;
    try {
      const predicates = [
        "published_at IS NULL",
        "dead_lettered_at IS NULL",
        "(lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP(3))",
        "next_attempt_at <= CURRENT_TIMESTAMP(3)",
        ...(this.eventType === undefined ? [] : ["event_type = $1"]),
        ...(this.tenantId === undefined
          ? []
          : [`tenant_id = $${this.eventType === undefined ? 1 : 2}`]),
      ];
      const args = [
        ...(this.eventType === undefined ? [] : [this.eventType]),
        ...(this.tenantId === undefined ? [] : [this.tenantId]),
      ];
      const [rows] = await this.connection.query<OutboxRow[]>(
        `SELECT outbox_id, event_type, payload_json, attempts
           FROM ${this.table}
          WHERE ${predicates.join(" AND ")}
          ORDER BY created_at, outbox_id
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        args,
      );
      row = rows[0];
      if (!row) {
        await this.connection.commit();
        return false;
      }
      await this.connection.execute(
        `UPDATE ${this.table}
            SET lease_token = $1, lease_until = CURRENT_TIMESTAMP(3) + ($2 * INTERVAL '1 second'), attempts = attempts + 1
          WHERE outbox_id = $3 AND published_at IS NULL`,
        [leaseToken, this.leaseSeconds, row.outbox_id],
      );
      await this.connection.commit();
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }

    const selectedRow = row;
    if (selectedRow === undefined)
      throw new Error("billing.outbox_row_missing_after_lease");
    let leaseLost = false;
    const renewLease = async (): Promise<void> => {
      const [renewal] = await this.leaseConnection.execute<ResultSetHeader>(
        `UPDATE ${this.table}
            SET lease_until = CURRENT_TIMESTAMP(3) + ($1 * INTERVAL '1 second')
          WHERE outbox_id = $2 AND lease_token = $3 AND published_at IS NULL AND dead_lettered_at IS NULL`,
        [this.leaseSeconds, selectedRow.outbox_id, leaseToken],
      );
      if (renewal.affectedRows !== 1) leaseLost = true;
    };
    const renewalTimer = setInterval(
      () => {
        void renewLease().catch((error: unknown) => {
          process.stderr.write(
            `kokoro-billing outbox lease renewal failed table=${this.table} outbox_id=${selectedRow.outbox_id} error=${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      },
      Math.max(1_000, Math.floor((this.leaseSeconds * 1_000) / 3)),
    );
    try {
      const payload = parsePersistedJson(
        selectedRow.payload_json,
        jsonRecordSchema,
        "billing.outbox_payload_invalid",
      );
      await handler({
        outboxId: selectedRow.outbox_id,
        eventType: selectedRow.event_type,
        payload,
      });
      if (leaseLost) return "lease_lost";
      const [published] = await this.leaseConnection.execute<ResultSetHeader>(
        `UPDATE ${this.table}
            SET published_at = CURRENT_TIMESTAMP(3), lease_token = NULL, lease_until = NULL
          WHERE outbox_id = $1 AND lease_token = $2 AND published_at IS NULL`,
        [selectedRow.outbox_id, leaseToken],
      );
      if (published.affectedRows !== 1) return "lease_lost";
      return "published";
    } catch (error) {
      if (leaseLost) return "lease_lost";
      const attemptNumber = selectedRow.attempts + 1;
      if (attemptNumber >= this.maxAttempts) {
        const [deadLettered] =
          await this.leaseConnection.execute<ResultSetHeader>(
            `UPDATE ${this.table}
              SET dead_lettered_at = CURRENT_TIMESTAMP(3), lease_token = NULL, lease_until = NULL
            WHERE outbox_id = $1 AND lease_token = $2 AND published_at IS NULL`,
            [selectedRow.outbox_id, leaseToken],
          );
        if (deadLettered.affectedRows !== 1) return "lease_lost";
        process.stderr.write(
          `kokoro-billing outbox dead-lettered table=${this.table} outbox_id=${selectedRow.outbox_id} attempts=${attemptNumber}\n`,
        );
        return "dead_lettered";
      }
      const [retry] = await this.leaseConnection.execute<ResultSetHeader>(
        `UPDATE ${this.table}
            SET lease_token = NULL, lease_until = NULL, next_attempt_at = CURRENT_TIMESTAMP(3) + (LEAST(attempts, 60) * INTERVAL '1 second')
          WHERE outbox_id = $1 AND lease_token = $2 AND published_at IS NULL`,
        [selectedRow.outbox_id, leaseToken],
      );
      if (retry.affectedRows !== 1) return "lease_lost";
      process.stderr.write(
        `kokoro-billing outbox retry table=${this.table} outbox_id=${selectedRow.outbox_id} attempt=${attemptNumber} error=${error instanceof Error ? error.message : String(error)}\n`,
      );
      return "retrying";
    } finally {
      clearInterval(renewalTimer);
    }
  }
}
