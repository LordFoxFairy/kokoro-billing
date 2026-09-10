import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { QueryResult, RowDataPacket, SqlConnection } from "./database.js";
export type {
  QueryResult,
  ResultSetHeader,
  RowDataPacket,
  SqlConnection,
} from "./database.js";

type TransactionState = {
  readonly client: PoolClient;
  readonly onError: (error: Error) => void;
  depth: number;
  failure?: { readonly error: unknown };
  released: boolean;
};
type BillingContext = {
  transactions: Map<PostgresConnection, TransactionState>;
};
const billingContext = new AsyncLocalStorage<BillingContext>();

function postgresSearchPath(uri: string): string {
  const schema = new URL(uri).searchParams.get("schema") ?? "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema))
    throw new Error(
      "DATABASE_URL schema must be a simple PostgreSQL identifier",
    );
  return schema === "public"
    ? "public,pg_catalog"
    : `${schema},public,pg_catalog`;
}

/** Bind one request/worker operation to one PostgreSQL session. */
export function runWithBillingContext<T>(task: () => T): T {
  return billingContext.run({ transactions: new Map() }, task);
}

class PostgresConnection implements SqlConnection {
  private readonly pool: Pool;

  public constructor(uri: string) {
    const poolSize = Number(process.env.POSTGRES_POOL_SIZE ?? 10);
    if (!Number.isSafeInteger(poolSize) || poolSize < 2)
      throw new RangeError(
        "POSTGRES_POOL_SIZE must be an integer of at least 2",
      );
    this.pool = new Pool({
      connectionString: uri,
      max: poolSize,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      options: `-c search_path=${postgresSearchPath(uri)}`,
    });
    // pg-pool removes failed idle clients itself; never release them again here.
    this.pool.on("error", (error: Error) => this.diagnose("pool_idle", error));
  }

  private diagnose(operation: string, error: unknown): void {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z0-9]{5}$/.test(error.code)
        ? error.code
        : "connection_error";
    try {
      console.error(
        JSON.stringify({
          service: "billing",
          operation,
          result: "failed",
          error_code: code,
        }),
      );
    } catch {
      // Diagnostics must never throw from a driver's EventEmitter error listener.
    }
  }

  private poison(transaction: TransactionState, error: unknown): void {
    if (transaction.failure !== undefined) return;
    transaction.failure = { error };
    this.diagnose("postgres_transaction", error);
  }

  private assertHealthy(transaction: TransactionState): void {
    if (transaction.failure !== undefined) throw transaction.failure.error;
  }

  private release(
    context: BillingContext,
    transaction: TransactionState,
  ): void {
    if (transaction.released) return;
    transaction.released = true;
    try {
      transaction.client.release(
        transaction.failure !== undefined ? true : undefined,
      );
    } catch (error) {
      if (transaction.failure === undefined) throw error;
      this.diagnose("postgres_release", error);
    } finally {
      // release installs pg-pool's listener; remove only this checkout's listener.
      transaction.client.off("error", transaction.onError);
      context.transactions.delete(this);
    }
  }

  private async control(
    transaction: TransactionState,
    sql: string,
  ): Promise<void> {
    this.assertHealthy(transaction);
    try {
      await transaction.client.query(sql);
    } catch (error) {
      this.poison(transaction, error);
      throw error;
    }
  }

  private async client(): Promise<Pool | PoolClient> {
    const transaction = billingContext.getStore()?.transactions.get(this);
    if (transaction) {
      this.assertHealthy(transaction);
      return transaction.client;
    }
    return Promise.resolve(this.pool);
  }

  private async runQuery<T extends QueryResult>(
    sql: string,
    values: unknown[] | undefined,
  ): Promise<[T, unknown[]]> {
    const client = await this.client();
    const result = await client
      .query<QueryResultRow>(sql, values)
      .catch((error: unknown) => {
        const transaction = billingContext.getStore()?.transactions.get(this);
        if (
          transaction &&
          error instanceof Error &&
          "severity" in error &&
          (error.severity === "FATAL" || error.severity === "PANIC")
        ) {
          this.poison(transaction, error);
        }
        throw error;
      });
    const isMutation = !/^\s*(SELECT|WITH\b[\s\S]*\bSELECT)\b/iu.test(sql);
    const payload = (
      isMutation ? { affectedRows: result.rowCount ?? 0 } : result.rows
    ) as T;
    return [payload, []];
  }

  public query<T extends QueryResult = RowDataPacket[]>(
    sql: string,
    values?: unknown[],
  ): Promise<[T, unknown[]]> {
    return this.runQuery<T>(sql, values);
  }
  public execute<T extends QueryResult = RowDataPacket[]>(
    sql: string,
    values?: unknown[],
  ): Promise<[T, unknown[]]> {
    return this.runQuery<T>(sql, values);
  }

  public async beginTransaction(): Promise<void> {
    // Production requests and workers establish a request/operation context.
    // For direct command invocation (for example a CLI or an integration test),
    // enter an isolated context instead of sharing a hidden singleton client.
    const context = billingContext.getStore() ?? {
      transactions: new Map<PostgresConnection, TransactionState>(),
    };
    if (!billingContext.getStore()) billingContext.enterWith(context);
    const active = context.transactions.get(this);
    if (active) {
      const nextDepth = active.depth + 1;
      await this.control(active, `SAVEPOINT billing_sp_${nextDepth}`);
      active.depth = nextDepth;
      return;
    }
    const client = await this.pool.connect();
    const transaction: TransactionState = {
      client,
      depth: 1,
      released: false,
      onError: (error) => this.poison(transaction, error),
    };
    client.on("error", transaction.onError);
    try {
      await this.control(transaction, "BEGIN");
      context.transactions.set(this, transaction);
    } catch (error) {
      this.release(context, transaction);
      throw error;
    }
  }

  public async commit(): Promise<void> {
    const context = billingContext.getStore();
    if (!context) throw new Error("billing transaction is not active");
    const transaction = context.transactions.get(this);
    if (!transaction) throw new Error("billing transaction is not active");
    if (transaction.depth > 1) {
      await this.control(
        transaction,
        `RELEASE SAVEPOINT billing_sp_${transaction.depth}`,
      );
      transaction.depth -= 1;
      return;
    }
    try {
      await this.control(transaction, "COMMIT");
    } finally {
      this.release(context, transaction);
    }
  }

  public async rollback(): Promise<void> {
    const context = billingContext.getStore();
    if (!context) return;
    const transaction = context.transactions.get(this);
    if (!transaction) return;
    if (transaction.depth > 1) {
      const savepoint = `billing_sp_${transaction.depth}`;
      try {
        await this.control(transaction, `ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.control(transaction, `RELEASE SAVEPOINT ${savepoint}`);
      } finally {
        // Even a dead connection must unwind one level, keeping the outer scope poisoned.
        transaction.depth -= 1;
      }
      return;
    }
    try {
      await this.control(transaction, "ROLLBACK");
    } finally {
      this.release(context, transaction);
    }
  }

  public async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    await this.beginTransaction();
    try {
      const result = await work();
      await this.commit();
      return result;
    } catch (error) {
      try {
        await this.rollback();
      } catch (cleanupError) {
        this.diagnose("postgres_rollback", cleanupError);
      }
      throw error;
    }
  }

  public async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async end(): Promise<void> {
    await this.pool.end();
  }
}

export function createBillingConnection(uri: string): Promise<SqlConnection> {
  return Promise.resolve(new PostgresConnection(uri));
}
export const createDedicatedBillingConnection = (
  uri: string,
): Promise<SqlConnection> => Promise.resolve(new PostgresConnection(uri));
