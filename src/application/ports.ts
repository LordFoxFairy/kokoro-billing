export type RowDataPacket = Record<string, unknown>;
export type ResultSetHeader = { readonly affectedRows: number; readonly insertId?: string };
export type QueryResult = unknown;

/** Persistence port shared by Billing application services and adapters. */
export interface Connection {
  query<T extends QueryResult = RowDataPacket[]>(sql: string, values?: unknown[]): Promise<[T, unknown[]]>;
  execute<T extends QueryResult = RowDataPacket[]>(sql: string, values?: unknown[]): Promise<[T, unknown[]]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  ping(): Promise<void>;
  end(): Promise<void>;
}
