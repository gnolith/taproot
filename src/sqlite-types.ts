/** Runtime-neutral result shape shared with Diamond 0.5 SQL adapters. */
export interface SqliteResultLike<T = Record<string, unknown>> {
  results: readonly T[];
  success?: boolean;
  meta?: Readonly<Record<string, unknown>>;
}

/** Minimum prepared-statement capability required by Taproot. */
export interface SqlitePreparedStatementLike {
  bind(...values: readonly unknown[]): SqlitePreparedStatementLike;
  run<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>>;
  all<T = Record<string, unknown>>(): Promise<SqliteResultLike<T>>;
}

/** Minimum asynchronous atomic-batch SQLite capability required by Taproot. */
export interface SqliteDatabaseLike {
  prepare(sql: string): SqlitePreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: readonly SqlitePreparedStatementLike[],
  ): Promise<readonly SqliteResultLike<T>[]>;
}

export type D1ResultLike<T = Record<string, unknown>> = SqliteResultLike<T>;
export type D1PreparedStatementLike = SqlitePreparedStatementLike;
export type D1DatabaseLike = SqliteDatabaseLike;
export interface SqliteFirstCapability {
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
