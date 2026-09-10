import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { QueryResult, RowDataPacket, SqlConnection } from "./database.js";
export type {
  QueryResult,
  ResultSetHeader,
  RowDataPacket,
  SqlConnection,
} from "./database.js";

type TransactionState = { readonly client: PoolClient; depth: number };
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
  }

  private async client(): Promise<Pool | PoolClient> {
    const transaction = billingContext.getStore()?.transactions.get(this);
    if (transaction) return Promise.resolve(transaction.client);
    return Promise.resolve(this.pool);
  }

  private async runQuery<T extends QueryResult>(
    sql: string,
    values: unknown[] | undefined,
  ): Promise<[T, unknown[]]> {
    const result = await (
      await this.client()
    ).query<QueryResultRow>(sql, values);
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
      await active.client.query(`SAVEPOINT billing_sp_${nextDepth}`);
      active.depth = nextDepth;
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      context.transactions.set(this, { client, depth: 1 });
    } catch (error) {
      client.release();
      throw error;
    }
  }

  public async commit(): Promise<void> {
    const context = billingContext.getStore();
    if (!context) throw new Error("billing transaction is not active");
    const transaction = context.transactions.get(this);
    if (!transaction) throw new Error("billing transaction is not active");
    if (transaction.depth > 1) {
      await transaction.client.query(
        `RELEASE SAVEPOINT billing_sp_${transaction.depth}`,
      );
      transaction.depth -= 1;
      return;
    }
    try {
      await transaction.client.query("COMMIT");
    } finally {
      context.transactions.delete(this);
      transaction.client.release();
    }
  }

  public async rollback(): Promise<void> {
    const context = billingContext.getStore();
    if (!context) return;
    const transaction = context.transactions.get(this);
    if (!transaction) return;
    if (transaction.depth > 1) {
      const savepoint = `billing_sp_${transaction.depth}`;
      await transaction.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await transaction.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      transaction.depth -= 1;
      return;
    }
    try {
      await transaction.client.query("ROLLBACK");
    } finally {
      context.transactions.delete(this);
      transaction.client.release();
    }
  }

  public async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    await this.beginTransaction();
    try {
      const result = await work();
      await this.commit();
      return result;
    } catch (error) {
      await this.rollback();
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
