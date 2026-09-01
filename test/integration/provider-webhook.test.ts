import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RowDataPacket } from '../../src/infrastructure/postgres/connection.js';
import { createBillingConnection } from '../../src/infrastructure/postgres/connection.js';
import { ProviderEventInboxService } from '../../src/modules/payment/provider-event-inbox-service.js';
import { ProviderEventAdminService } from '../../src/modules/payment/provider-event-admin-service.js';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('provider webhook inbox', () => {
  it('stores a signed provider event once and returns the same fact on replay', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = new ProviderEventInboxService(connection);
    const siteId = randomUUID();
    const externalEventId = `evt-${randomUUID()}`;
    try {
      const input = {
        siteId,
        provider: 'mock',
        externalEventId,
        eventType: 'payment.succeeded',
        rawPayload: { id: externalEventId, amount: 1000 },
        signatureValid: true,
      } as const;
      const first = await service.accept(input);
      const replay = await service.accept(input);
      expect(first.providerEventId).toBe(replay.providerEventId);
      expect(first.processingStatus).toBe('received');
      await connection.execute(`UPDATE payment_provider_event SET processing_status = 'processed' WHERE provider_event_id = $1`, [first.providerEventId]);
      const processedReplay = await service.accept(input);
      expect(processedReplay.processingStatus).toBe('processed');
      const [events] = await connection.query('SELECT provider_event_id FROM payment_provider_event WHERE tenant_id = $1 AND external_event_id = $2', [siteId, externalEventId]);
      const [outbox] = await connection.query('SELECT outbox_id FROM payment_outbox WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_type = $3', ['provider_event', first.providerEventId, 'PaymentProviderEventReceived']);
      expect(events).toHaveLength(1);
      expect(outbox).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it('rejects an event before persistence when the provider signature is invalid', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = new ProviderEventInboxService(connection);
    await expect(service.accept({
      siteId: randomUUID(),
      provider: 'mock',
      externalEventId: `evt-${randomUUID()}`,
      eventType: 'payment.succeeded',
      rawPayload: {},
      signatureValid: false,
    })).rejects.toThrow('billing.provider_signature');
    await connection.end();
  });

  it('rejects the same external event id with a different payload', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const service = new ProviderEventInboxService(connection);
    const siteId = randomUUID();
    const externalEventId = `evt-${randomUUID()}`;
    try {
      await service.accept({ siteId, provider: 'mock', externalEventId, eventType: 'payment.succeeded', rawPayload: { id: externalEventId, amount: 1000 }, signatureValid: true });
      await expect(service.accept({ siteId, provider: 'mock', externalEventId, eventType: 'payment.succeeded', rawPayload: { id: externalEventId, amount: 2000 }, signatureValid: true })).rejects.toThrow('billing.idempotency_conflict');
    } finally {
      await connection.end();
    }
  });

  it('requeues a failed event with a durable audited command', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const inbox = new ProviderEventInboxService(connection);
    const admin = new ProviderEventAdminService(connection);
    const siteId = randomUUID();
    try {
      const accepted = await inbox.accept({ siteId, provider: 'mock', externalEventId: `evt-${randomUUID()}`, eventType: 'payment.succeeded', rawPayload: { ok: true }, signatureValid: true });
      await connection.execute(`UPDATE payment_provider_event SET processing_status = 'failed', last_error = 'temporary' WHERE provider_event_id = $1`, [accepted.providerEventId]);
      const first = await admin.retry({ siteId, providerEventId: accepted.providerEventId, operatorId: 'operator-1', reason: 'provider timeout', idempotencyKey: `retry-${randomUUID()}` });
      const replay = await admin.retry({ siteId, providerEventId: accepted.providerEventId, operatorId: 'operator-1', reason: 'provider timeout', idempotencyKey: (await connection.query<(RowDataPacket & { idempotency_key: string })[]>('SELECT idempotency_key FROM payment_command_receipt WHERE tenant_id = $1 AND command_name = \'ProviderEventRetry\'', [siteId]))[0][0]!.idempotency_key });
      expect(first).toEqual({ providerEventId: accepted.providerEventId, processingStatus: 'received' });
      expect(replay).toEqual(first);
      const [outbox] = await connection.query<(RowDataPacket & { published_at: Date | null; attempts: number })[]>('SELECT published_at, attempts FROM payment_outbox WHERE aggregate_type = \'provider_event\' AND aggregate_id = $1', [accepted.providerEventId]);
      expect(outbox[0]?.published_at).toBeNull();
      expect(Number(outbox[0]?.attempts)).toBe(0);
      const [audit] = await connection.query('SELECT audit_event_id FROM entitlement_audit_event WHERE tenant_id = $1 AND action = \'provider_event_retry\'', [siteId]);
      expect(audit).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });

  it('lists only the current site and supports processing-status filtering', async () => {
    const connection = await createBillingConnection(databaseUrl!);
    const inbox = new ProviderEventInboxService(connection);
    const admin = new ProviderEventAdminService(connection);
    const siteId = randomUUID();
    const otherSiteId = randomUUID();
    try {
      const failed = await inbox.accept({ siteId, provider: 'mock', externalEventId: `evt-${randomUUID()}`, eventType: 'payment.failed', rawPayload: { ok: false }, signatureValid: true });
      const failedAgain = await inbox.accept({ siteId, provider: 'mock', externalEventId: `evt-${randomUUID()}`, eventType: 'payment.failed', rawPayload: { ok: false }, signatureValid: true });
      await inbox.accept({ siteId, provider: 'mock', externalEventId: `evt-${randomUUID()}`, eventType: 'payment.succeeded', rawPayload: { ok: true }, signatureValid: true });
      await inbox.accept({ siteId: otherSiteId, provider: 'mock', externalEventId: `evt-${randomUUID()}`, eventType: 'payment.failed', rawPayload: { ok: false }, signatureValid: true });
      await connection.execute(`UPDATE payment_provider_event SET processing_status = 'failed', processing_attempts = 2, last_error = 'temporary' WHERE provider_event_id = $1`, [failed.providerEventId]);
      await connection.execute(`UPDATE payment_provider_event SET processing_status = 'failed', processing_attempts = 1, last_error = 'retryable' WHERE provider_event_id = $1`, [failedAgain.providerEventId]);

      const firstPage = await admin.list({ siteId, status: 'failed', limit: 1 });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBeTruthy();
      const result = await admin.list({ siteId, status: 'failed', limit: 10, cursor: firstPage.nextCursor! });
      expect(result.items).toHaveLength(1);
      expect(new Set([failed.providerEventId, failedAgain.providerEventId])).toContain(firstPage.items[0]?.providerEventId);
      expect(new Set([failed.providerEventId, failedAgain.providerEventId])).toContain(result.items[0]?.providerEventId);
      expect(result.items[0]?.providerEventId).not.toBe(firstPage.items[0]?.providerEventId);
    } finally {
      await connection.end();
    }
  });
});
