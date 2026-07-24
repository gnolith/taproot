import type { SqlitePreparedStatementLike } from './sqlite-types.js';

/**
 * Package-internal hook used by sealed owner participants to join the exact
 * canonical mutation batch. It is deliberately not re-exported by index.ts.
 */
export const coordinatedStatementsV1 = Symbol(
  'taproot.coordinated-statements-v1',
);

export type CoordinatedMutationV1 = {
  [coordinatedStatementsV1]?: readonly SqlitePreparedStatementLike[];
};

export function coordinatedStatements(
  value: unknown,
): readonly SqlitePreparedStatementLike[] {
  if (!value || typeof value !== 'object') return [];
  const statements = (value as CoordinatedMutationV1)[coordinatedStatementsV1];
  return Array.isArray(statements)
    ? (statements as SqlitePreparedStatementLike[])
    : [];
}
