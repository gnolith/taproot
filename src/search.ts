export * from './search-kinds.js';
export * from './external-search-producers.js';
export * from './search-contract.js';
export * from './search-service.js';
export * from './search-materialization.js';
export * from './semantic-search.js';

import type { D1DatabaseLike } from './sqlite-types.js';
import {
  assertTaprootHostWriteCapabilityInternal,
  type TaprootHostWriteCapability,
} from './assembly-authority.js';
import {
  createSearchMaterializationRuntimeV1,
  type SearchMaterializationAdminGuardV1,
  type SearchMaterializationContentOptionsV1,
} from './search-materialization.js';

/** Assembly-issued, opaque and bounded materialization runner/maintenance guard. */
export async function createSearchMaterializationAdminGuardV1(
  db: D1DatabaseLike,
  options: { baseIri: string; clock?: () => Date },
  hostCapability: TaprootHostWriteCapability,
  contentOptions: SearchMaterializationContentOptionsV1 = {},
): Promise<SearchMaterializationAdminGuardV1> {
  assertTaprootHostWriteCapabilityInternal(db, options, hostCapability);
  const state = await db
    .prepare(
      `SELECT installation_id FROM taproot_installation_authorization
       WHERE singleton = 1`,
    )
    .all<{ installation_id: string }>();
  const installationId = state.results[0]?.installation_id;
  if (!installationId)
    throw new Error('Taproot authorization bootstrap is incomplete');
  return createSearchMaterializationRuntimeV1({
    db,
    installationId,
    clock: options.clock ?? (() => new Date()),
    ...contentOptions,
  });
}
