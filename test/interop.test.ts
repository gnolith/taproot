import { createSparqlHandler, type D1DatabaseLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { runTaprootInteropDemo } from '../examples/d1-diamond-interop/demo.js';

describe('local D1 and Diamond interoperability example', () => {
  it('coordinates guarded Taproot writes, persisted authorization, and Diamond SPARQL on local Workerd D1', async () => {
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
      const bindings = (
        result.sparqlResults as { results: { bindings: unknown[] } }
      ).results.bindings;
      expect(bindings.length).toBeGreaterThan(0);
      expect(typeof createSparqlHandler({ db })).toBe('function');
    } finally {
      await miniflare.dispose();
    }
  }, 60_000);
});
