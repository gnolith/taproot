import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapTaprootAuthorization,
  createTaprootHostWriteCapability,
  initializeTaproot,
  type AuthorizationContext,
} from '../src/index.js';
import { createSearchMaterializationAdminGuardV1 } from '../src/search.js';

const options = { baseIri: 'https://materialization-reset.example' };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('bounded search lifecycle', () => {
  it('initializes exactly four ready built-in producers without timers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-lifecycle-'));
    directories.push(directory);
    const db = new NodeSqliteDatabase(join(directory, 'db.sqlite'));
    try {
      await initializeTaproot(db, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const authority = createTaprootHostWriteCapability(db, options, key);
      await bootstrapTaprootAuthorization(
        db,
        options,
        authority,
        'installation',
      );
      const admin = await createSearchMaterializationAdminGuardV1(
        db,
        options,
        authority,
      );
      await admin.initialize(context());
      const producers = await db
        .prepare(
          `SELECT source_kind, state
           FROM taproot_unified_search_producer_adoptions
           ORDER BY source_kind`,
        )
        .all<{ source_kind: string; state: string }>();
      expect(producers.results).toEqual([
        { source_kind: 'annotation', state: 'ready' },
        { source_kind: 'item', state: 'ready' },
        { source_kind: 'resource', state: 'ready' },
        { source_kind: 'statement', state: 'ready' },
      ]);
    } finally {
      await db.close();
    }
  });
});

function context(): AuthorizationContext {
  return {
    installationId: 'installation',
    principalId: 'admin',
    activeWorkspaceId: null,
    workspaceIds: [],
    capabilities: ['search:admin'],
    authorizationRevision: 1,
  };
}
