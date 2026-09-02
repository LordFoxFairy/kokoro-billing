import { createBillingConnection, runWithBillingContext } from '../src/infrastructure/postgres/connection.js';
import { RedisLease } from '../src/infrastructure/redis/lease.js';
import { UsageSettlementService } from '../src/modules/metering/usage-settlement-service.js';
import { GrantExpiryService } from '../src/modules/credit/grant-expiry-service.js';
import { recordExpiryRun, startWorkerMetricsServer } from '../src/infrastructure/worker-metrics.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
const connection = await createBillingConnection(databaseUrl);
const lease = new RedisLease(redisUrl);
await lease.connect();
const daemon = process.env.DAEMON === 'true';
const pollMs = Number(process.env.BILLING_EXPIRY_POLL_MS ?? 5_000);
if (!Number.isSafeInteger(pollMs) || pollMs < 500 || pollMs > 300_000) throw new Error('BILLING_EXPIRY_POLL_MS must be an integer between 500 and 300000');
const metricsPort = Number(process.env.BILLING_EXPIRY_METRICS_PORT ?? 9096);
if (!Number.isSafeInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535) throw new Error('BILLING_EXPIRY_METRICS_PORT must be an integer between 1 and 65535');
const metricsServer = await startWorkerMetricsServer(metricsPort, process.env.BILLING_EXPIRY_METRICS_HOST ?? '127.0.0.1');
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
try {
  do {
    const result = await lease.runExclusive('credit-hold-expiry', 60, async () => {
      return runWithBillingContext(() => {
        const usage = new UsageSettlementService(connection);
        const grants = new GrantExpiryService(connection);
        const tenantId = process.env.BILLING_TENANT_ID;
        const limit = process.env.BILLING_EXPIRY_LIMIT === undefined ? undefined : Number(process.env.BILLING_EXPIRY_LIMIT);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('BILLING_EXPIRY_LIMIT must be a positive integer');
        const holds = usage.expireExpiredHolds({
          ...(tenantId ? { tenantId: tenantId } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
        return holds.then(async (holdResult) => ({ ...holdResult, ...(await grants.expireExpiredGrants({ ...(tenantId ? { tenantId: tenantId } : {}), ...(limit === undefined ? {} : { limit }) })) }));
      });
    });
    recordExpiryRun(result === undefined ? 'skipped' : 'completed');
    console.log(JSON.stringify(result ?? { skipped: 'lease_not_acquired' }));
    if (!daemon || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (!stopping);
} finally {
  await metricsServer.close();
  await lease.close();
  await connection.end();
}
