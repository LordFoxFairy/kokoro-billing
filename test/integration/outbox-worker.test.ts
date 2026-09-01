import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import { OutboxWorker } from '../../src/infrastructure/postgres/outbox-worker.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('PostgreSQL outbox worker', () => {
  it('claims, publishes and marks one event exactly once', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const outboxId = randomUUID();
    let calls = 0;
    try {
      await connection.execute(`DELETE FROM entitlement_outbox WHERE event_type = 'TestEvent'`);
      await connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'test', $3, 'TestEvent', $4)`,
        [outboxId, randomUUID(), randomUUID(), JSON.stringify({ outboxId })],
      );
      const worker = new OutboxWorker(connection, 'entitlement_outbox', 30, 'TestEvent');
      expect(await worker.processOnce(async (event) => {
        calls += 1;
        expect(event.outboxId).toBe(outboxId);
      })).toBe('published');
      expect(await worker.processOnce(async () => { calls += 1; })).toBe(false);
      expect(calls).toBe(1);
      const [rows] = await connection.query<(RowDataPacket & { published_at: Date | null })[]>('SELECT published_at FROM entitlement_outbox WHERE outbox_id = $1', [outboxId]);
      expect(rows[0]?.published_at).not.toBeNull();
    } finally {
      await connection.end();
    }
  });

  it('dead-letters a poison event after the configured attempt budget', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const outboxId = randomUUID();
    try {
      await connection.execute(`DELETE FROM entitlement_outbox WHERE event_type = 'PoisonTestEvent'`);
      await connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'test', $3, 'PoisonTestEvent', $4)`,
        [outboxId, randomUUID(), randomUUID(), JSON.stringify({ outboxId })],
      );
      const worker = new OutboxWorker(connection, 'entitlement_outbox', 30, 'PoisonTestEvent', 1);
      expect(await worker.processOnce(async () => { throw new Error('poison'); })).toBe('dead_lettered');
      const [rows] = await connection.query<(RowDataPacket & { dead_lettered_at: Date | null })[]>('SELECT dead_lettered_at FROM entitlement_outbox WHERE outbox_id = $1', [outboxId]);
      expect(rows[0]?.dead_lettered_at).not.toBeNull();
      expect(await worker.processOnce(async () => undefined)).toBe(false);
    } finally {
      await connection.end();
    }
  });

  it('renews the database lease while a handler is running', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const leaseConnection = await createBillingConnection(databaseUrl!);
    const outboxId = randomUUID();
    try {
      await connection.execute(`DELETE FROM entitlement_outbox WHERE event_type = 'SlowTestEvent'`);
      await connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'test', $3, 'SlowTestEvent', $4)`,
        [outboxId, randomUUID(), randomUUID(), JSON.stringify({ outboxId })],
      );
      const worker = new OutboxWorker(connection, 'entitlement_outbox', 1, 'SlowTestEvent', 10, undefined, leaseConnection);
      expect(await worker.processOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      })).toBe('published');
    } finally {
      await leaseConnection.end();
      await connection.end();
    }
  });
});
