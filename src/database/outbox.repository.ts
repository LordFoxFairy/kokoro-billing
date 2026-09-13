import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import type { AuditAppender } from "./audit-appender.js";
import { OutboxError } from "./outbox.error.js";
import {
  registeredOutboxEventTypes,
  type OutboxClaimInput,
  type OutboxEnqueueInput,
  type OutboxFence,
  type OutboxLease,
  type OutboxRequeueInput,
} from "./outbox.types.js";
import type { TransactionService } from "./transaction.service.js";
import type { TransactionClient } from "./transaction.types.js";
import { toPersistedJson } from "./persisted-json.js";

type ClaimedRow = {
  id: string;
  tenant_id: string;
  event_namespace: string;
  event_type: string;
  event_identity: string;
  payload_schema_version: number;
  payload_digest: string;
  payload_json: unknown;
  lease_token: string;
  lease_until: Date;
  attempts: number;
};

export class OutboxRepository {
  readonly #transactions: TransactionService;
  readonly #audit: AuditAppender;

  constructor(transactions: TransactionService, audit: AuditAppender) {
    this.#transactions = transactions;
    this.#audit = audit;
  }

  async enqueue(input: OutboxEnqueueInput): Promise<string> {
    this.#validateEnqueue(input);
    const { client } = this.#transactions.requireActive(input.tenantId);
    const locks = [
      `outbox:identity:${input.namespace}:${input.eventIdentity}`,
      `outbox:aggregate:${input.namespace}:${input.aggregateType}:${input.aggregateId}:${input.eventType}`,
    ].sort();
    for (const lock of locks)
      await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const [identity, aggregate] = await Promise.all([
      client.billing_outbox.findUnique({
        where: {
          event_namespace_event_identity: {
            event_namespace: input.namespace,
            event_identity: input.eventIdentity,
          },
        },
      }),
      client.billing_outbox.findFirst({
        where: {
          event_namespace: input.namespace,
          aggregate_type: input.aggregateType,
          aggregate_id: input.aggregateId,
          event_type: input.eventType,
        },
      }),
    ]);
    if (identity || aggregate) {
      if (!identity || !aggregate || identity.id !== aggregate.id)
        throw new OutboxError(
          "OUTBOX_CONFLICT",
          "Outbox uniqueness domains disagree",
        );
      if (
        identity.tenant_id !== input.tenantId ||
        identity.payload_schema_version !== input.payloadSchemaVersion ||
        identity.payload_digest !== input.payloadDigest
      )
        throw new OutboxError(
          "OUTBOX_CONFLICT",
          "Outbox identity belongs to another event",
        );
      return identity.id;
    }
    const id = randomUUID();
    await client.billing_outbox.create({
      data: {
        id,
        tenant_id: input.tenantId,
        event_namespace: input.namespace,
        aggregate_type: input.aggregateType,
        aggregate_id: input.aggregateId,
        event_type: input.eventType,
        event_identity: input.eventIdentity,
        payload_schema_version: input.payloadSchemaVersion,
        payload_digest: input.payloadDigest,
        payload_json: toPersistedJson(input.payload),
        ...(input.nextAttemptAt === undefined
          ? {}
          : { next_attempt_at: input.nextAttemptAt }),
      },
    });
    return id;
  }

  async claimNext(input: OutboxClaimInput): Promise<readonly OutboxLease[]> {
    this.#validateClaim(input);
    const { client } = this.#transactions.requireActive(input.tenantId);
    const token = randomUUID();
    const rows = await client.$queryRaw<ClaimedRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT id FROM billing_outbox
        WHERE tenant_id = ${input.tenantId}
          AND event_namespace = ${input.namespace}
          AND event_type IN (${Prisma.join(input.eventTypes)})
          AND completed_at IS NULL AND dead_lettered_at IS NULL
          AND next_attempt_at <= clock_timestamp()
          AND (lease_token IS NULL OR lease_until <= clock_timestamp())
        ORDER BY next_attempt_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      )
      UPDATE billing_outbox AS o
      SET lease_token = ${token}::uuid,
          lease_until = clock_timestamp() + make_interval(secs => ${input.leaseMs} / 1000.0),
          attempts = attempts + 1
      FROM candidates c WHERE o.id = c.id
      RETURNING o.id, o.tenant_id, o.event_namespace, o.event_type,
        o.event_identity, o.payload_schema_version, o.payload_digest,
        o.payload_json, o.lease_token, o.lease_until, o.attempts
    `);
    return rows.map((row) => this.#claimedRow(row));
  }

  #claimedRow(row: ClaimedRow): OutboxLease {
    if (
      typeof row.id !== "string" ||
      typeof row.tenant_id !== "string" ||
      typeof row.event_namespace !== "string" ||
      typeof row.event_type !== "string" ||
      typeof row.event_identity !== "string" ||
      typeof row.payload_schema_version !== "number" ||
      typeof row.payload_digest !== "string" ||
      typeof row.lease_token !== "string" ||
      !(row.lease_until instanceof Date) ||
      typeof row.attempts !== "number"
    )
      throw new OutboxError(
        "OUTBOX_INVALID_INPUT",
        "Invalid claimed outbox row",
      );
    return {
      id: row.id,
      tenantId: row.tenant_id,
      namespace: row.event_namespace as "payment",
      eventType: row.event_type,
      eventIdentity: row.event_identity,
      payloadSchemaVersion: row.payload_schema_version,
      payloadDigest: row.payload_digest,
      payload: row.payload_json,
      leaseToken: row.lease_token,
      leaseUntil: row.lease_until,
      attempts: row.attempts,
    };
  }

  async renew(fence: OutboxFence, leaseMs: number): Promise<boolean> {
    this.#validateLeaseMs(leaseMs);
    const { client } = this.#transactions.requireActive(fence.tenantId);
    if (!(await this.#lockFence(client, fence))) return false;
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      UPDATE billing_outbox SET lease_until = clock_timestamp() + make_interval(secs => ${leaseMs} / 1000.0)
      WHERE tenant_id = ${fence.tenantId} AND event_namespace = ${fence.namespace}
        AND id = ${fence.id}::uuid AND lease_token = ${fence.leaseToken}::uuid
        AND completed_at IS NULL AND dead_lettered_at IS NULL
        AND lease_until > clock_timestamp() RETURNING id`;
    return rows.length === 1;
  }

  async complete(fence: OutboxFence): Promise<boolean> {
    return await this.#terminal(fence, "complete");
  }

  async deadLetter(fence: OutboxFence, errorCode: string): Promise<boolean> {
    return await this.#terminal(fence, "deadLetter", errorCode);
  }

  async retry(
    fence: OutboxFence,
    errorCode: string,
    delayMs: number,
  ): Promise<boolean> {
    this.#validateLeaseMs(delayMs);
    const { client } = this.#transactions.requireActive(fence.tenantId);
    if (!(await this.#lockFence(client, fence))) return false;
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      UPDATE billing_outbox SET lease_token = NULL, lease_until = NULL,
        next_attempt_at = clock_timestamp() + make_interval(secs => ${delayMs} / 1000.0),
        last_error_code = ${errorCode}
      WHERE tenant_id = ${fence.tenantId} AND event_namespace = ${fence.namespace}
        AND id = ${fence.id}::uuid AND lease_token = ${fence.leaseToken}::uuid
        AND completed_at IS NULL AND dead_lettered_at IS NULL
        AND lease_until > clock_timestamp() RETURNING id`;
    return rows.length === 1;
  }

  async requeue(input: OutboxRequeueInput): Promise<boolean> {
    if (
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 0
    )
      throw new OutboxError(
        "OUTBOX_INVALID_INPUT",
        "Invalid requeue generation",
      );
    const { client } = this.#transactions.requireActive(input.tenantId);
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      UPDATE billing_outbox SET dead_lettered_at = NULL, last_error_code = NULL,
        next_attempt_at = clock_timestamp(), attempts = 0,
        requeue_generation = requeue_generation + 1
      WHERE id = ${input.id}::uuid AND tenant_id = ${input.tenantId}
        AND event_namespace = ${input.namespace} AND completed_at IS NULL
        AND dead_lettered_at IS NOT NULL AND requeue_generation = ${input.expectedGeneration}
        AND last_error_code <> 'delivery_retired_by_migration'
      RETURNING id`;
    if (rows.length === 1)
      await this.#audit.append({
        tenantId: input.tenantId,
        action: "billing.outbox.requeued",
        resourceType: "outbox",
        resourceId: input.id,
        reason: input.reason,
        payload: {
          namespace: input.namespace,
          previous_generation: input.expectedGeneration,
        },
      });
    return rows.length === 1;
  }

  async #terminal(
    fence: OutboxFence,
    action: "complete" | "deadLetter",
    errorCode?: string,
  ): Promise<boolean> {
    const { client } = this.#transactions.requireActive(fence.tenantId);
    if (!(await this.#lockFence(client, fence))) return false;
    const rows =
      action === "complete"
        ? await client.$queryRaw<Array<{ id: string }>>`
          UPDATE billing_outbox SET completed_at = clock_timestamp(), lease_token = NULL,
            lease_until = NULL, last_error_code = NULL
          WHERE tenant_id = ${fence.tenantId} AND event_namespace = ${fence.namespace}
            AND id = ${fence.id}::uuid AND lease_token = ${fence.leaseToken}::uuid
            AND completed_at IS NULL AND dead_lettered_at IS NULL
            AND lease_until > clock_timestamp() RETURNING id`
        : await client.$queryRaw<Array<{ id: string }>>`
          UPDATE billing_outbox SET dead_lettered_at = clock_timestamp(), lease_token = NULL,
            lease_until = NULL, last_error_code = ${errorCode ?? "outbox.failed"}
          WHERE tenant_id = ${fence.tenantId} AND event_namespace = ${fence.namespace}
            AND id = ${fence.id}::uuid AND lease_token = ${fence.leaseToken}::uuid
            AND completed_at IS NULL AND dead_lettered_at IS NULL
            AND lease_until > clock_timestamp() RETURNING id`;
    return rows.length === 1;
  }

  async #lockFence(
    client: TransactionClient,
    fence: OutboxFence,
  ): Promise<boolean> {
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM billing_outbox
      WHERE tenant_id = ${fence.tenantId} AND event_namespace = ${fence.namespace}
        AND id = ${fence.id}::uuid AND lease_token = ${fence.leaseToken}::uuid
        AND completed_at IS NULL AND dead_lettered_at IS NULL
      FOR UPDATE`;
    return rows.length === 1;
  }

  #validateEnqueue(input: OutboxEnqueueInput): void {
    if (
      !registeredOutboxEventTypes.includes(input.eventType) ||
      input.payloadSchemaVersion < 1 ||
      !/^[0-9a-f]{64}$/.test(input.payloadDigest)
    )
      throw new OutboxError("OUTBOX_INVALID_INPUT", "Invalid outbox event");
  }

  #validateClaim(input: OutboxClaimInput): void {
    this.#validateLeaseMs(input.leaseMs);
    if (
      input.limit < 1 ||
      input.limit > 100 ||
      input.eventTypes.length === 0 ||
      input.eventTypes.some(
        (event) => !registeredOutboxEventTypes.includes(event),
      )
    )
      throw new OutboxError("OUTBOX_INVALID_INPUT", "Invalid outbox claim");
  }

  #validateLeaseMs(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new OutboxError("OUTBOX_INVALID_INPUT", "Invalid outbox duration");
  }
}
