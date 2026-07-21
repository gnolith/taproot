import { createSparqlHandler, type D1DatabaseLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { runTaprootInteropDemo } from '../examples/d1-diamond-interop/demo.js';
import {
  AuthorizationDeniedError,
  TaprootRepository,
  createAuthorizedTaproot,
  initializeTaproot,
  type EntityAuthorizationSource,
} from '../src/index.js';

describe('local D1 and Diamond interoperability example', () => {
  it('coordinates Taproot writes and Diamond SPARQL on local Workerd D1', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    try {
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      const result = await runTaprootInteropDemo(db);
      expect(result.staleRevisionRejected).toBe(true);
      expect(result.integrity).toMatchObject({ valid: true });
      expect(result.audit).toHaveLength(4);
      expect(result.entityJson).toContain('Ada Lovelace');
      expect(result.sparqlResults).toBeTypeOf('object');
      const bindings = (
        result.sparqlResults as {
          results: { bindings: unknown[] };
        }
      ).results.bindings;
      expect(bindings.length).toBeGreaterThan(0);

      // The public Diamond handler remains usable after the example completes.
      expect(typeof createSparqlHandler({ db })).toBe('function');
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);

  it('enforces the same pre/post-hydration authorization boundary on real Workerd D1', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-19',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: crypto.randomUUID() },
    });
    try {
      const db = (await miniflare.getD1Database(
        'DB',
      )) as unknown as D1DatabaseLike;
      const options = { baseIri: 'https://authorization.example' };
      await initializeTaproot(db, options);
      await new TaprootRepository(db, options).createItem({ id: 'Q1' });
      let installationRevision = 4;
      const source: EntityAuthorizationSource = {
        getInstallationAuthorizationState: () =>
          Promise.resolve({
            installationId: 'installation-1',
            authorizationRevision: installationRevision,
          }),
        getEntityAuthorization: () =>
          Promise.resolve({
            installationId: 'installation-1',
            authorizationRevision: 4,
            visibility: {
              version: 1,
              clauses: [[{ kind: 'workspace', workspaceId: 'workspace-1' }]],
            },
          }),
      };
      const reader = createAuthorizedTaproot(
        db,
        options,
        {
          installationId: 'installation-1',
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
          workspaceIds: ['workspace-1'],
          capabilities: [],
          authorizationRevision: 4,
        },
        source,
      );
      await expect(reader.getEntity('Q1')).resolves.toMatchObject({
        entity: { id: 'Q1' },
      });
      installationRevision = 5;
      await expect(reader.getEntity('Q1')).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);
});
