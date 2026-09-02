import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Connection, QueryResult, RowDataPacket } from '../../application/ports.js';
export type { Connection, QueryResult, ResultSetHeader, RowDataPacket } from '../../application/ports.js';

type BillingContext = { transaction: PoolClient | undefined };
const billingContext = new AsyncLocalStorage<BillingContext>();

function postgresSearchPath(uri: string): string {
  const schema = new URL(uri).searchParams.get('schema') ?? 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new Error('DATABASE_URL schema must be a simple PostgreSQL identifier');
  return schema === 'public' ? 'public,pg_catalog' : `${schema},public,pg_catalog`;
}

/** Bind one request/worker operation to one PostgreSQL session. */
export function runWithBillingContext<T>(task: () => T): T {
  return billingContext.run({ transaction: undefined }, task);
}

/**
 * A few repository predicates are assembled conditionally with `?` while the
 * fixed part uses PostgreSQL placeholders. Normalize the mixed form once at
 * the connection boundary so every query remains PostgreSQL-native and its
 * value order stays deterministic.
 */
const normalizeSql = (sql: string): string => {
  if (!sql.includes('?')) return sql;
  let questionCount = 0;
  let maxOriginal = 0;
  let quote: "'" | '"' | undefined;
  let output = '';
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (quote) {
      output += character;
      if (character === quote && sql[index - 1] !== '\\') quote = undefined;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === '?') {
      questionCount += 1;
      output += `$${maxOriginal + questionCount}`;
      index += 1;
      continue;
    }
    if (character === '$') {
      const match = /^\$(\d+)/u.exec(sql.slice(index));
      if (match) {
        const original = Number(match[1]);
        maxOriginal = Math.max(maxOriginal, original);
        output += `$${original + questionCount}`;
        index += match[0].length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
};

class PostgresConnection implements Connection {
  private readonly pool: Pool;
  private fallback?: Promise<PoolClient>;

  public constructor(private readonly uri: string) {
    const poolSize = Number(process.env.POSTGRES_POOL_SIZE ?? 10);
    if (!Number.isSafeInteger(poolSize) || poolSize < 2) throw new RangeError('POSTGRES_POOL_SIZE must be an integer of at least 2');
    this.pool = new Pool({ connectionString: uri, max: poolSize, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, options: `-c search_path=${postgresSearchPath(uri)}` });
  }

  private async fallbackClient(): Promise<PoolClient> {
    this.fallback ??= this.pool.connect();
    return this.fallback;
  }

  private async client(): Promise<Pool | PoolClient> {
    const transaction = billingContext.getStore()?.transaction;
    if (transaction) return transaction;
    return billingContext.getStore() ? this.pool : this.fallbackClient();
  }

  private async run<T extends QueryResult>(sql: string, values: unknown[] | undefined): Promise<[T, unknown[]]> {
    const result = await (await this.client()).query<QueryResultRow>(normalizeSql(sql), values);
    const isMutation = !/^\s*(SELECT|WITH\b[\s\S]*\bSELECT)\b/iu.test(sql);
    const payload = (isMutation ? { affectedRows: result.rowCount ?? 0 } : result.rows) as T;
    return [payload, []];
  }

  public query<T extends QueryResult = RowDataPacket[]>(sql: string, values?: unknown[]): Promise<[T, unknown[]]> { return this.run<T>(sql, values); }
  public execute<T extends QueryResult = RowDataPacket[]>(sql: string, values?: unknown[]): Promise<[T, unknown[]]> { return this.run<T>(sql, values); }

  public async beginTransaction(): Promise<void> {
    const context = billingContext.getStore();
    if (!context) { await (await this.fallbackClient()).query('BEGIN'); return; }
    if (context.transaction) throw new Error('nested billing transaction is not supported');
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); context.transaction = client; }
    catch (error) { client.release(); throw error; }
  }

  public async commit(): Promise<void> {
    const context = billingContext.getStore();
    if (!context) { await (await this.fallbackClient()).query('COMMIT'); return; }
    const client = context.transaction;
    if (!client) throw new Error('billing transaction is not active');
    try { await client.query('COMMIT'); }
    finally { context.transaction = undefined; client.release(); }
  }

  public async rollback(): Promise<void> {
    const context = billingContext.getStore();
    if (!context) { await (await this.fallbackClient()).query('ROLLBACK'); return; }
    const client = context.transaction;
    if (!client) return;
    try { await client.query('ROLLBACK'); }
    finally { context.transaction = undefined; client.release(); }
  }

  public async ping(): Promise<void> { await this.pool.query('SELECT 1'); }

  public async end(): Promise<void> {
    if (this.fallback) (await this.fallback).release();
    await this.pool.end();
  }
}

export function createBillingConnection(uri: string): Promise<Connection> { return Promise.resolve(new PostgresConnection(uri)); }
export const createDedicatedBillingConnection = (uri: string): Promise<Connection> => Promise.resolve(new PostgresConnection(uri));
