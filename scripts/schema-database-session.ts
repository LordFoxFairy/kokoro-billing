import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

export type CatalogQuery = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

export async function withSchemaSession<T>(
  url: string,
  work: (query: CatalogQuery) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("schema session timeout must be a positive integer");
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    statement_timeout: timeoutMs,
  });
  let client: PoolClient | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let cleanupError: unknown;
  let hasCleanupError = false;
  let connectionError: Error | undefined;
  let rejectActive: ((error: Error) => void) | undefined;
  let released = false;
  let broken = false;
  const onError = (error: Error): void => {
    broken = true;
    connectionError ??= error;
    rejectActive?.(error);
  };
  pool.on("error", onError);
  const release = (destroy: boolean): void => {
    if (!client || released) return;
    released = true;
    try {
      client.release(destroy);
    } catch (error) {
      if (!hasCleanupError) {
        cleanupError = error;
        hasCleanupError = true;
      }
    }
  };
  try {
    client = await pool.connect();
    client.on("error", onError);
    const query: CatalogQuery = async (sql, values) => {
      if (connectionError) throw connectionError;
      let timer: NodeJS.Timeout | undefined;
      let rejectConnection!: (error: Error) => void;
      const disconnected = new Promise<never>((_resolve, reject) => {
        rejectConnection = reject;
      });
      rejectActive = rejectConnection;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `schema database query exceeded ${timeoutMs}ms`,
          );
          broken = true;
          connectionError ??= error;
          release(true);
          reject(error);
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          client!.query(sql, values),
          deadline,
          disconnected,
        ]);
      } finally {
        rejectActive = undefined;
        if (timer) clearTimeout(timer);
      }
    };
    result = await work(query);
    if (connectionError && !hasPrimaryError) {
      primaryError = connectionError;
      hasPrimaryError = true;
    }
  } catch (error) {
    if (!hasPrimaryError) {
      primaryError = error;
      hasPrimaryError = true;
    }
  } finally {
    release(broken);
    let closeTimer: NodeJS.Timeout | undefined;
    const closing = pool.end().finally(() => {
      client?.removeListener("error", onError);
      pool.removeListener("error", onError);
    });
    try {
      await Promise.race([
        closing,
        new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(
            () =>
              reject(
                new Error(`schema database close exceeded ${timeoutMs}ms`),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (!hasCleanupError) {
        cleanupError = error;
        hasCleanupError = true;
      }
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
  }
  if (hasPrimaryError && hasCleanupError)
    throw new AggregateError(
      [primaryError, cleanupError],
      "schema session and cleanup failed",
      { cause: primaryError },
    );
  if (hasPrimaryError) throw primaryError;
  if (hasCleanupError) throw cleanupError;
  return result!;
}
