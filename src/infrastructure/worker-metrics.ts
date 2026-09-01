import Fastify, { type FastifyInstance } from 'fastify';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export type WorkerResult = 'published' | 'retrying' | 'dead_lettered' | 'lease_lost';

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'billing_worker_' });
const resultTotals = new Counter({ name: 'billing_worker_results_total', help: 'Outbox worker results by disposition.', labelNames: ['result'] as const, registers: [registry] });
const oldestPendingAgeSeconds = new Gauge({ name: 'billing_worker_oldest_pending_age_seconds', help: 'Age of the oldest pending payment outbox row.', registers: [registry] });
const expiryRunsTotal = new Counter({ name: 'billing_expiry_runs_total', help: 'Scheduler-triggered credit expiry runs by disposition.', labelNames: ['result'] as const, registers: [registry] });

export function recordWorkerResult(result: WorkerResult): void {
  try { resultTotals.inc({ result }); } catch { /* metrics are fail-open */ }
}

export function setOldestPendingAgeSeconds(value: number): void {
  try { oldestPendingAgeSeconds.set(Number.isFinite(value) && value >= 0 ? value : 0); } catch { /* metrics are fail-open */ }
}

export function recordExpiryRun(result: 'completed' | 'skipped'): void {
  try { expiryRunsTotal.inc({ result }); } catch { /* metrics are fail-open */ }
}

export async function startWorkerMetricsServer(port: number, host = '127.0.0.1'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (_request, reply) => {
    try { return reply.code(200).header('content-type', registry.contentType).send(await registry.metrics()); }
    catch { return reply.code(200).header('content-type', 'text/plain; version=0.0.4').send(''); }
  });
  await app.listen({ host, port });
  return app;
}
