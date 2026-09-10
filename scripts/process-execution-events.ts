import { createDedicatedBillingConnection } from "../src/infrastructure/postgres/connection.js";
import type { RowDataPacket } from "../src/infrastructure/postgres/connection.js";
import {
  createPostgresBillingAdmissionService,
  createPostgresUsageSettlementService,
} from "../src/infrastructure/postgres/create-postgres-services.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const connection = await createDedicatedBillingConnection(databaseUrl);
const usage = createPostgresUsageSettlementService(connection);
const admission = createPostgresBillingAdmissionService(connection, usage);
const limit = Math.min(
  Math.max(Number(process.env.BILLING_EVENT_BATCH_SIZE ?? 100), 1),
  500,
);
try {
  const [events] = await connection.query<
    (RowDataPacket & { tenant_id: string; event_id: string })[]
  >(
    `SELECT tenant_id, event_id FROM entitlement_execution_event
      WHERE status = 'received' ORDER BY occurred_at, event_id LIMIT $1`,
    [limit],
  );
  let processed = 0;
  for (const event of events) {
    try {
      await admission.processExecutionEvent(event.tenant_id, event.event_id);
      processed += 1;
    } catch (error) {
      process.stderr.write(
        `kokoro-billing execution event retry event_id=${event.event_id} error=${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  console.log(JSON.stringify({ processed, received: events.length }));
} finally {
  await connection.end();
}
