/** Runtime-neutral result shape returned by supported SQLite/D1 adapters. */
export interface SqliteResultLike<T = Record<string, unknown>> {
  results: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

/** Minimum prepared-statement capability required by Taproot. */
export interface SqlitePreparedStatementLike {
  bind(...values: unknown[]): SqlitePreparedStatementLike;
  run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>>;
  all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>>;
}

/** Minimum asynchronous atomic-batch SQLite capability required by Taproot. */
export interface SqliteDatabaseLike {
  prepare(sql: string): SqlitePreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: SqlitePreparedStatementLike[],
  ): Promise<Array<SqliteResultLike<T>>>;
}

/** D1-compatible aliases retained for public host bindings. */
export type D1ResultLike<T = Record<string, unknown>> = SqliteResultLike<T>;
export type D1PreparedStatementLike = SqlitePreparedStatementLike;
export type D1DatabaseLike = SqliteDatabaseLike;

/** Optional row convenience supported by adapters that expose `first()`. */
export interface SqliteFirstCapability {
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
