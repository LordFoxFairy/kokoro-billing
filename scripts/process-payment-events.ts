import { createBillingConnection, runWithBillingContext } from '../src/infrastructure/postgres/connection.js';
import { OutboxWorker } from '../src/infrastructure/postgres/outbox-worker.js';
import { createProviderRegistry } from '../src/infrastructure/providers/payment/provider-registry.js';
import { ALL_PAYMENT_PROVIDERS } from '../src/config/provider-config.js';
import { recordWorkerResult, setOldestPendingAgeSeconds, startWorkerMetricsServer, type WorkerResult } from '../src/infrastructure/worker-metrics.js';
import type { RowDataPacket } from '../src/infrastructure/postgres/connection.js';
import { createPostgresBillingReversalService, createPostgresBillingSettlementService, createPostgresProviderEventProcessor, createPostgresSubscriptionGrantService } from '../src/infrastructure/postgres/create-postgres-services.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const connection = await createBillingConnection(databaseUrl);
// Lease writes use a separate PostgreSQL session. They must never join a handler's
// business transaction or be rolled back with it.
const leaseConnection = await createBillingConnection(databaseUrl);
const metricsPort = Number(process.env.BILLING_WORKER_METRICS_PORT ?? 9095);
if (!Number.isSafeInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535) throw new Error('BILLING_WORKER_METRICS_PORT must be an integer between 1 and 65535');
const metricsServer = await startWorkerMetricsServer(metricsPort, process.env.BILLING_WORKER_METRICS_HOST ?? '127.0.0.1');
const processor = createPostgresProviderEventProcessor(
  connection,
  // Processing is deliberately broader than ingress: disabling a provider must
  // not strand already-inboxed events. Main validates the enabled ingress list.
  createProviderRegistry(ALL_PAYMENT_PROVIDERS, process.env.WECHAT_API_V3_KEY ? { wechatApiV3Key: process.env.WECHAT_API_V3_KEY } : {}),
  createPostgresBillingSettlementService(connection),
  createPostgresBillingReversalService(connection),
  createPostgresSubscriptionGrantService(connection),
);
const once = process.env.ONCE === 'true';
const pollMs = Number(process.env.BILLING_WORKER_POLL_MS ?? 1_000);
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('BILLING_WORKER_POLL_MS must be an integer between 100 and 60000');
const maxAttempts = Number(process.env.BILLING_OUTBOX_MAX_ATTEMPTS ?? 10);
if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error('BILLING_OUTBOX_MAX_ATTEMPTS must be an integer between 1 and 100');
const paymentWorker = new OutboxWorker(connection, 'payment_outbox', 30, 'PaymentProviderEventReceived', maxAttempts, undefined, leaseConnection);
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

try {
  const run = async (): Promise<{ readonly processed: number; readonly retried: number; readonly deadLettered: number; readonly leaseLost: number }> => {
    let processed = 0;
    let retried = 0;
    let deadLettered = 0;
    let leaseLost = 0;
    while (!stopping) {
      const result = await runWithBillingContext(() => paymentWorker.processOnce(async (event) => {
        const providerEventId = typeof event.payload.providerEventId === 'string' ? event.payload.providerEventId : null;
        if (!providerEventId) throw new Error('billing.provider_event_outbox_payload_invalid');
        await processor.process(providerEventId);
      }));
      if (result !== false) {
        recordWorkerResult(result as WorkerResult);
        if (result === 'published') processed += 1;
        if (result === 'retrying') retried += 1;
        if (result === 'dead_lettered') deadLettered += 1;
        if (result === 'lease_lost') leaseLost += 1;
        if (once) break;
        continue;
      }
      try {
        const [rows] = await connection.query<(RowDataPacket & { age_seconds: number | string | null })[]>(`SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) AS age_seconds FROM payment_outbox WHERE event_type = 'PaymentProviderEventReceived' AND published_at IS NULL AND dead_lettered_at IS NULL ORDER BY created_at, outbox_id LIMIT 1`);
        setOldestPendingAgeSeconds(rows[0]?.age_seconds === null || rows[0]?.age_seconds === undefined ? 0 : Number(rows[0].age_seconds));
      } catch { /* metrics must not stop the worker */ }
      if (once) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { processed, retried, deadLettered, leaseLost };
  };
  // PostgreSQL SKIP LOCKED + per-row leases provide the worker concurrency boundary.
  // Do not serialize all payment events behind a process-wide Redis lock.
  console.log(JSON.stringify(await run()));
} finally {
  await metricsServer.close();
  await leaseConnection.end();
  await connection.end();
}
