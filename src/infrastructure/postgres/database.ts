import type { TransactionPort } from "../../application/ports/transaction.js";

export type RowDataPacket = Record<string, unknown>;
export type ResultSetHeader = {
  readonly affectedRows: number;
  readonly insertId?: string;
};
export type QueryResult = unknown;

/** PostgreSQL primitives stay inside Infrastructure. */
export interface SqlConnection extends TransactionPort {
  query<T extends QueryResult = RowDataPacket[]>(
    sql: string,
    values?: unknown[],
  ): Promise<[T, unknown[]]>;
  execute<T extends QueryResult = RowDataPacket[]>(
    sql: string,
    values?: unknown[],
  ): Promise<[T, unknown[]]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  ping(): Promise<void>;
  end(): Promise<void>;
}
