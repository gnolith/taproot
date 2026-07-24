import type { SqlitePreparedStatementLike } from './sqlite-types.js';

/**
 * Package-internal hook used by sealed owner participants to join the exact
 * canonical mutation batch. It is deliberately not re-exported by index.ts.
 */
export const coordinatedStatementsV1 = Symbol(
  'taproot.coordinated-statements-v1',
);
export const authorizationVisibilityAdministrationV1 = Symbol(
  'taproot.authorization-visibility-administration-v1',
);

export type CoordinatedMutationV1 = {
  [coordinatedStatementsV1]?: readonly SqlitePreparedStatementLike[];
  [authorizationVisibilityAdministrationV1]?: true;
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

export function permitsVisibilityAdministration(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as CoordinatedMutationV1)[
      authorizationVisibilityAdministrationV1
    ] === true,
  );
}
