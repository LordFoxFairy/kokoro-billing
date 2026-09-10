import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export type CanonicalSchemaInstallation = {
  readonly databaseUrl: string;
  readonly schemaSql: string;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly clientQueryTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
};

const INSTALLATION_LOCK = 'kokoro-billing:canonical-schema';

function positiveMilliseconds(value: number | undefined, fallback: number, name: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual <= 0) throw new RangeError(`${name} must be a positive integer`);
  return actual;
}

function validateDatabaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('databaseUrl must be a PostgreSQL connection string');
  }
  const schemas = url.searchParams.getAll('schema');
  if (schemas.some((schema) => schema !== 'public')) {
    throw new Error('DATABASE_URL schema parameters must all be public');
  }
  return url;
}

async function rollbackWithoutMasking(rollback: () => Promise<unknown>, originalError: unknown, markBroken: () => void): Promise<never> {
  try { await rollback(); } catch { markBroken(); /* Preserve the installation failure. */ }
  throw originalError;
}

/** Install the SQL authority into an exclusive, empty Billing database. */
export async function installCanonicalSchema(input: CanonicalSchemaInstallation): Promise<void> {
  const url = validateDatabaseUrl(input.databaseUrl);
  if (input.schemaSql.trim() === '') throw new Error('canonical schema SQL must not be empty');

  const lockTimeoutMs = positiveMilliseconds(input.lockTimeoutMs, 5_000, 'lockTimeoutMs');
  const statementTimeoutMs = positiveMilliseconds(input.statementTimeoutMs, 30_000, 'statementTimeoutMs');
  const idleTimeoutMs = positiveMilliseconds(input.idleInTransactionTimeoutMs, 30_000, 'idleInTransactionTimeoutMs');
  const connectionTimeoutMs = positiveMilliseconds(input.connectionTimeoutMs, 10_000, 'connectionTimeoutMs');
  const clientQueryTimeoutMs = positiveMilliseconds(input.clientQueryTimeoutMs, 35_000, 'clientQueryTimeoutMs');
  const closeTimeoutMs = positiveMilliseconds(input.closeTimeoutMs, 5_000, 'closeTimeoutMs');
  const pool = new Pool({
    connectionString: url.toString(),
    max: 1,
    connectionTimeoutMillis: connectionTimeoutMs,
    statement_timeout: statementTimeoutMs,
    lock_timeout: lockTimeoutMs,
    idle_in_transaction_session_timeout: idleTimeoutMs,
  });

  let client: PoolClient | undefined;
  let failure: { error: unknown } | undefined;
  let brokenClient = false;
  let clientReleased = false;
  let connectionError: Error | undefined;
  let rejectActiveQuery: ((error: Error) => void) | undefined;
  const onConnectionError = (error: Error): void => {
    brokenClient = true;
    connectionError ??= error;
    rejectActiveQuery?.(error);
  };
  pool.on('error', onConnectionError);
  const releaseClient = (destroy: boolean): void => {
    if (!client || clientReleased) return;
    clientReleased = true;
    try { client.release(destroy); } catch (error) {
      brokenClient = true;
      connectionError ??= error instanceof Error ? error : new Error(String(error));
    }
  };
  try {
    const activeClient = await pool.connect();
    client = activeClient;
    client.on('error', onConnectionError);
    const query = async <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> => {
      if (connectionError) throw connectionError;
      let timeout: NodeJS.Timeout | undefined;
      let rejectConnection!: (error: Error) => void;
      const disconnected = new Promise<never>((_resolve, reject) => { rejectConnection = reject; });
      rejectActiveQuery = rejectConnection;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          brokenClient = true;
          releaseClient(true);
          reject(new Error(`canonical schema database query exceeded ${clientQueryTimeoutMs}ms`));
        }, clientQueryTimeoutMs);
      });
      try { return await Promise.race([activeClient.query<T>(text, values), deadline, disconnected]); }
      finally {
        rejectActiveQuery = undefined;
        if (timeout) clearTimeout(timeout);
      }
    };
    await query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      await query("SELECT pg_catalog.set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
      await query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
      await query("SELECT pg_catalog.set_config('idle_in_transaction_session_timeout', $1, true)", [`${idleTimeoutMs}ms`]);
      await query("SELECT pg_catalog.set_config('TimeZone', 'UTC', true)");
      await query("SELECT pg_catalog.set_config('search_path', 'public,pg_catalog', true)");
      await query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [INSTALLATION_LOCK]);

      const publicSchema = await query<{ exists: boolean; can_create: boolean }>(`
        SELECT n.oid IS NOT NULL AS exists,
               COALESCE(pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE'), false) AS can_create
        FROM (VALUES ('public'::pg_catalog.name)) AS requested(name)
        LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = requested.name
      `);
      if (!publicSchema.rows[0]?.exists) throw new Error('public schema must exist before canonical schema installation');
      if (!publicSchema.rows[0].can_create) throw new Error('current database role requires CREATE privilege on public schema');

      const objects = await query<{ kind: string; schema_name: string; object_name: string }>(`
        WITH user_namespaces AS (
          SELECT oid, nspname FROM pg_catalog.pg_namespace
          WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        ), user_relations AS (
          SELECT 'relation'::text AS kind, n.nspname AS schema_name, c.relname AS object_name
          FROM pg_catalog.pg_class c JOIN user_namespaces n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        ), independent_types AS (
          SELECT 'type'::text AS kind, n.nspname AS schema_name, t.typname AS object_name
          FROM pg_catalog.pg_type t JOIN user_namespaces n ON n.oid = t.typnamespace
          LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
          LEFT JOIN pg_catalog.pg_type array_base ON array_base.typarray = t.oid
          WHERE (t.typrelid = 0 OR c.relkind = 'c') AND array_base.oid IS NULL
        ), user_functions AS (
          SELECT 'function'::text AS kind, n.nspname AS schema_name, p.proname AS object_name
          FROM pg_catalog.pg_proc p JOIN user_namespaces n ON n.oid = p.pronamespace
        )
        SELECT kind, schema_name, object_name FROM user_relations
        UNION ALL SELECT kind, schema_name, object_name FROM independent_types
        UNION ALL SELECT kind, schema_name, object_name FROM user_functions
        ORDER BY schema_name, kind, object_name
      `);
      if (objects.rows.length > 0) {
        const summary = objects.rows.map((item) => `${item.schema_name}.${item.object_name} (${item.kind})`).join(', ');
        throw new Error(`canonical schema installation requires a non-empty-object-free database; found: ${summary}`);
      }

      await query(input.schemaSql);
      await query('COMMIT');
    } catch (error) {
      await rollbackWithoutMasking(() => query('ROLLBACK'), error, () => { brokenClient = true; });
    }
  } catch (error) {
    failure = { error };
  } finally {
    releaseClient(brokenClient);
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      const closeDeadline = new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => reject(new Error(`canonical schema pool close exceeded ${closeTimeoutMs}ms`)), closeTimeoutMs);
      });
      const closing = pool.end().finally(() => {
        client?.removeListener('error', onConnectionError);
        pool.removeListener('error', onConnectionError);
      });
      await Promise.race([closing, closeDeadline]);
    } catch (closeError) { failure ??= { error: closeError }; }
    if (closeTimer) clearTimeout(closeTimer);
  }
  if (failure !== undefined) throw failure.error;
}
