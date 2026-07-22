import { createSparqlHandler, type D1DatabaseLike } from '@gnolith/diamond';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  EntityAlreadyExistsError,
  EntityTooLargeError,
  InvalidEntityError,
  InvalidStatementError,
  PERSISTED_STATEMENT_TEXT_PAGE_SIZE,
  PropertyDatatypeMismatchError,
  PropertyNotFoundError,
  QuadPatchTooLargeError,
  RevisionConflictError,
  SchemaMismatchError,
  TaprootMigrationStateError,
  applyTaprootMigrations,
  initializeTaproot,
  inspectTaprootPersistence,
  legacyTaprootV1Statements,
  inspectTaprootSchema,
  taprootAuthorizationSchemaStatements,
  taprootSearchSourceEventSchemaStatements,
  taprootSearchMaterializationSchemaStatements,
  taprootExternalSearchProducerSchemaStatements,
  type Reference,
  type Snak,
  type Statement,
} from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

const options = { baseIri: 'https://knowledge.example' };

async function environment() {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-19',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
  await initializeTaproot(db, options);
  return {
    db,
    repository: new TaprootRepository(db, options),
    dispose: () => miniflare.dispose(),
  };
}

async function dropAuthorizationSchema(db: D1DatabaseLike): Promise<void> {
  const objects = [
    ...taprootAuthorizationSchemaStatements,
    ...taprootSearchSourceEventSchemaStatements,
    ...taprootSearchMaterializationSchemaStatements,
    ...taprootExternalSearchProducerSchemaStatements,
  ]
    .map((sql) =>
      /^CREATE (TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z0-9_]+)/iu.exec(
        sql,
      ),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .reverse();
  await db.batch(
    objects.map((match) =>
      db.prepare(`DROP ${match[1]!.toUpperCase()} IF EXISTS ${match[2]}`),
    ),
  );
}

describe('TaprootRepository on Workerd D1', () => {
  it.each(['current', 'historical'] as const)(
    'keyset-paginates D1 %s data and rejects a violation after page one',
    async (source) => {
      const env = await environment();
      try {
        await dropAuthorizationSchema(env.db);
        await env.db.batch([
          env.db.prepare(
            `DELETE FROM _gnolith_migrations
             WHERE namespace = '@gnolith/taproot'
               AND migration_id IN (
                 '0003-canonical-statement-text',
                 '0004-canonical-authorization-policy',
                 '0005-unified-search-source-events',
                 '0006-unified-search-materialization-lifecycle',
                 '0007-external-search-producers'
               )`,
          ),
          env.db.prepare(`DELETE FROM taproot_migrations WHERE version >= 3`),
          env.db.prepare(
            `UPDATE taproot_metadata SET metadata_value = '1'
             WHERE metadata_key = 'canonical_json_version'`,
          ),
        ]);
        await insertD1PagedCorpus(env.db, source);
        await expect(applyTaprootMigrations(env.db)).rejects.toBeInstanceOf(
          TaprootMigrationStateError,
        );
        const state = await env.db
          .prepare(
            `SELECT
               (SELECT metadata_value FROM taproot_metadata
                WHERE metadata_key = 'canonical_json_version') AS json_version,
               (SELECT COUNT(*) FROM _gnolith_migrations
                WHERE namespace = '@gnolith/taproot') AS ledger_count`,
          )
          .all<{ json_version: string; ledger_count: number }>();
        expect(state.results[0]).toMatchObject({
          json_version: '1',
          ledger_count: 2,
        });
      } finally {
        await env.dispose();
      }
    },
    30_000,
  );

  it('rejects Unicode-whitespace text in historical-only D1 migration data', async () => {
    const env = await environment();
    try {
      const current = JSON.stringify({
        id: 'Q1',
        type: 'item',
        labels: {},
        descriptions: {},
        aliases: {},
        claims: {},
        sitelinks: {},
        lastrevid: 2,
        modified: '2026-01-02T00:00:00.000Z',
      });
      const historical = JSON.stringify({
        ...JSON.parse(current),
        claims: {
          P1: [
            {
              id: 'Q1$historical',
              type: 'statement',
              text: '\u00a0',
              rank: 'normal',
              mainsnak: {
                snaktype: 'somevalue',
                property: 'P1',
                datatype: 'string',
              },
              qualifiers: {},
              'qualifiers-order': [],
              references: [],
            },
          ],
        },
        lastrevid: 1,
        modified: '2026-01-01T00:00:00.000Z',
      });
      await dropAuthorizationSchema(env.db);
      await env.db.batch([
        env.db.prepare(
          `DELETE FROM _gnolith_migrations
           WHERE namespace = '@gnolith/taproot'
             AND migration_id IN (
               '0003-canonical-statement-text',
                 '0004-canonical-authorization-policy',
                 '0005-unified-search-source-events',
                 '0006-unified-search-materialization-lifecycle',
                 '0007-external-search-producers'
             )`,
        ),
        env.db.prepare(`DELETE FROM taproot_migrations WHERE version >= 3`),
        env.db.prepare(
          `UPDATE taproot_metadata SET metadata_value = '1'
           WHERE metadata_key = 'canonical_json_version'`,
        ),
        env.db
          .prepare(
            `INSERT INTO taproot_entities(entity_id, entity_type, datatype, revision, entity_json, modified_at)
             VALUES ('Q1', 'item', NULL, 2, ?, '2026-01-02T00:00:00.000Z')`,
          )
          .bind(current),
        env.db
          .prepare(
            `INSERT INTO taproot_entity_revisions(
               entity_id, revision, entity_json, tags_json, event_id,
               content_hash, created_at
             ) VALUES ('Q1', 1, ?, '[]', 'historical-event',
               'historical-hash', '2026-01-01T00:00:00.000Z'),
               ('Q1', 2, ?, '[]', 'current-event',
               'current-hash', '2026-01-02T00:00:00.000Z')`,
          )
          .bind(historical, current),
      ]);
      await expect(applyTaprootMigrations(env.db)).rejects.toBeInstanceOf(
        TaprootMigrationStateError,
      );
    } finally {
      await env.dispose();
    }
  }, 20_000);

  it('enforces authored statement text and explicit resupply on D1', async () => {
    const env = await environment();
    try {
      await env.repository.createProperty({ id: 'P1', datatype: 'string' });
      await env.repository.createItem({ id: 'Q1' });
      const statement: Statement = {
        id: 'Q1$text-contract',
        type: 'statement',
        text: 'The item concerns wood-fired ceramics.',
        rank: 'normal',
        mainsnak: {
          snaktype: 'value',
          property: 'P1',
          datatype: 'string',
          datavalue: { type: 'string', value: 'wood-fired ceramics' },
        },
        qualifiers: {},
        'qualifiers-order': [],
        references: [],
      };
      await expect(
        env.repository.addStatement(
          'Q1',
          { ...statement, text: '   ' },
          {
            expectedRevision: 1,
          },
        ),
      ).rejects.toBeInstanceOf(InvalidStatementError);
      const added = await env.repository.addStatement('Q1', statement, {
        expectedRevision: 1,
      });
      await expect(
        env.repository.setStatementRank(
          'Q1',
          statement.id,
          'preferred',
          undefined as never,
          { expectedRevision: added.newRevision },
        ),
      ).rejects.toBeInstanceOf(InvalidStatementError);
      const updated = await env.repository.setStatementRank(
        'Q1',
        statement.id,
        'preferred',
        'The item concerns reviewed wood-fired ceramics.',
        { expectedRevision: added.newRevision },
      );
      expect(updated.entity.claims.P1?.[0]?.text).toBe(
        'The item concerns reviewed wood-fired ceramics.',
      );
      expect(
        (await env.repository.getEntityRevision('Q1', 2)).entity.claims.P1?.[0]
          ?.text,
      ).toBe('The item concerns wood-fired ceramics.');
    } finally {
      await env.dispose();
    }
  }, 20_000);

  it('upgrades a version-one database and backfills immutable audit history', async () => {
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
      await db.batch(
        legacyTaprootV1Statements.map((statement) => db.prepare(statement)),
      );
      await db
        .prepare(
          `INSERT INTO taproot_metadata(metadata_key, metadata_value)
           VALUES ('base_iri', 'HTTPS://Knowledge.Example///')`,
        )
        .run();
      const entity = JSON.stringify({
        id: 'Q1',
        type: 'item',
        labels: {},
        descriptions: {},
        aliases: {},
        claims: {},
        sitelinks: {},
        lastrevid: 1,
        modified: '2026-01-01T00:00:00.000Z',
      });
      await db
        .prepare(
          `INSERT INTO taproot_entities(entity_id, entity_type, revision, entity_json, modified_at) VALUES ('Q1', 'item', 1, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .bind(entity)
        .run();
      await db
        .prepare(
          `INSERT INTO taproot_entity_revisions(entity_id, revision, entity_json, actor) VALUES ('Q1', 1, ?, 'legacy-user')`,
        )
        .bind(entity)
        .run();
      const legacyOptions = { baseIri: 'HTTPS://Knowledge.Example///' };
      await initializeTaproot(db, legacyOptions);
      const repository = new TaprootRepository(db, legacyOptions);
      expect(await inspectTaprootSchema(db)).toMatchObject({ valid: true });
      await expect(inspectTaprootPersistence(db)).resolves.toMatchObject({
        baseIri: 'https://knowledge.example',
        current: true,
      });
      expect(await repository.verifyAuditChain('Q1')).toMatchObject({
        valid: true,
      });
      expect(
        (await repository.listAuditEvents({ entityId: 'Q1' })).items[0],
      ).toMatchObject({
        type: 'import',
        attribution: { id: 'legacy-user', kind: 'human' },
      });
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);

  it('initializes its schema and allocates independent P/Q ids', async () => {
    const env = await environment();
    try {
      await expect(inspectTaprootSchema(env.db)).resolves.toMatchObject({
        valid: true,
      });
      const property = await env.repository.createProperty({
        datatype: 'string',
      });
      const first = await env.repository.createItem();
      const second = await env.repository.createItem();
      expect([property.entityId, first.entityId, second.entityId]).toEqual([
        'P1',
        'Q1',
        'Q2',
      ]);
      await expect(
        env.repository.listEntityRevisions('Q1'),
      ).resolves.toHaveLength(1);
      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () => env.repository.createItem()),
      );
      expect(new Set(concurrent.map(({ entityId }) => entityId)).size).toBe(5);
    } finally {
      await env.dispose();
    }
  }, 30_000);

  it('synchronizes terms, revisions, statements, qualifiers, references, and RDF', async () => {
    const env = await environment();
    try {
      await env.repository.createProperty({
        datatype: 'string',
        labels: { en: { language: 'en', value: 'name' } },
      });
      await env.repository.createProperty({ datatype: 'time' });
      const created = await env.repository.createItem({
        labels: { en: { language: 'en', value: 'Ada Lovelace' } },
      });
      const mainsnak: Snak = {
        snaktype: 'value',
        property: 'P1',
        datatype: 'string',
        datavalue: { type: 'string', value: 'programmer' },
      };
      const qualifier: Snak = {
        snaktype: 'value',
        property: 'P2',
        datatype: 'time',
        datavalue: {
          type: 'time',
          value: {
            time: '+1843-01-01T00:00:00Z',
            timezone: 0,
            before: 0,
            after: 0,
            precision: 9,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      };
      const reference: Reference = {
        hash: 'source-1',
        snaks: {
          P1: [{ ...mainsnak, datavalue: { type: 'string', value: 'source' } }],
        },
        'snaks-order': ['P1'],
      };
      const statement: Statement = {
        id: 'Q1$s1',
        type: 'statement',
        text: 'Ada Lovelace worked as a programmer.',
        rank: 'normal',
        mainsnak,
        qualifiers: {},
        'qualifiers-order': [],
        references: [],
      };
      const withStatement = await env.repository.addStatement('Q1', statement, {
        expectedRevision: created.newRevision,
      });
      const withQualifier = await env.repository.addQualifier(
        'Q1',
        statement.id,
        qualifier,
        'Ada Lovelace worked as a programmer during this period.',
        { expectedRevision: withStatement.newRevision },
      );
      const withReference = await env.repository.addReference(
        'Q1',
        statement.id,
        reference,
        'Ada Lovelace worked as a programmer, according to source 1.',
        {
          expectedRevision: withQualifier.newRevision,
          actor: 'test',
          editSummary: 'source it',
        },
      );
      expect(withReference.entity.claims.P1?.[0]?.references[0]?.hash).toBe(
        'source-1',
      );
      await expect(
        env.repository.searchEntities('Ada', { language: 'en' }),
      ).resolves.toMatchObject([{ entityId: 'Q1', termType: 'label' }]);
      await expect(
        env.repository.listEntityRevisions('Q1'),
      ).resolves.toHaveLength(4);
      const handler = createSparqlHandler({ db: env.db });
      const query = `SELECT ?value WHERE { <https://knowledge.example/entity/Q1> <https://knowledge.example/prop/direct/P1> ?value }`;
      const response = await handler(
        new Request(
          `https://site.test/sparql?query=${encodeURIComponent(query)}`,
          { headers: { accept: 'application/sparql-results+json' } },
        ),
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        results: { bindings: Array<{ value: { value: string } }> };
      };
      expect(result.results.bindings[0]?.value.value).toBe('programmer');

      const fullQuery = `SELECT ?statement ?timeValue ?source WHERE {
        <https://knowledge.example/entity/Q1> <https://knowledge.example/prop/P1> ?statement .
        ?statement <https://knowledge.example/prop/statement/P1> "programmer" ;
          <https://knowledge.example/prop/qualifier/value/P2> ?timeValue ;
          <http://schema.org/isBasedOn> ?reference .
        ?timeValue <http://wikiba.se/ontology#timePrecision> 9 .
        ?reference <https://knowledge.example/prop/reference/P1> ?source
      }`;
      const fullResponse = await handler(
        new Request(
          `https://site.test/sparql?query=${encodeURIComponent(fullQuery)}`,
          { headers: { accept: 'application/sparql-results+json' } },
        ),
      );
      const fullResult = (await fullResponse.json()) as {
        results: { bindings: Array<{ source: { value: string } }> };
      };
      expect(fullResult.results.bindings[0]?.source.value).toBe('source');

      const replacementReference: Reference = {
        ...reference,
        hash: 'source-2',
      };
      const replacedReference = await env.repository.replaceReference(
        'Q1',
        statement.id,
        reference.hash,
        replacementReference,
        'Ada Lovelace worked as a programmer, according to source 2.',
        { expectedRevision: withReference.newRevision },
      );
      const removedReference = await env.repository.removeReference(
        'Q1',
        statement.id,
        replacementReference.hash,
        'Ada Lovelace worked as a programmer.',
        { expectedRevision: replacedReference.newRevision },
      );
      const removedQualifier = await env.repository.removeQualifier(
        'Q1',
        statement.id,
        'P2',
        0,
        'Ada Lovelace worked as a programmer.',
        { expectedRevision: removedReference.newRevision },
      );
      const ranked = await env.repository.setStatementRank(
        'Q1',
        statement.id,
        'preferred',
        'Ada Lovelace worked as a programmer (preferred statement).',
        { expectedRevision: removedQualifier.newRevision },
      );
      const replacementStatement: Statement = {
        ...statement,
        text: 'Ada Lovelace worked as a researcher.',
        rank: 'preferred',
        mainsnak: {
          ...mainsnak,
          datavalue: { type: 'string', value: 'researcher' },
        },
      };
      const replacedStatement = await env.repository.replaceStatement(
        'Q1',
        statement.id,
        replacementStatement,
        { expectedRevision: ranked.newRevision },
      );
      const removedStatement = await env.repository.removeStatement(
        'Q1',
        statement.id,
        { expectedRevision: replacedStatement.newRevision },
      );
      expect(removedStatement.entity.claims).toEqual({});
      await expect(
        env.repository.listEntityRevisions('Q1'),
      ).resolves.toHaveLength(10);
    } finally {
      await env.dispose();
    }
  }, 30_000);

  it('edits and removes terms, aliases, and sitelinks', async () => {
    const env = await environment();
    try {
      const created = await env.repository.createItem();
      const labeled = await env.repository.setLabel('Q1', 'en', 'label', {
        expectedRevision: created.newRevision,
      });
      const described = await env.repository.setDescription(
        'Q1',
        'en',
        'description',
        { expectedRevision: labeled.newRevision },
      );
      const aliased = await env.repository.addAlias('Q1', 'en', 'alias', {
        expectedRevision: described.newRevision,
      });
      const linked = await env.repository.setSitelink(
        'Q1',
        'enwiki',
        { site: 'ignored', title: 'Example', badges: [] },
        { expectedRevision: aliased.newRevision },
      );
      const noLabel = await env.repository.removeLabel('Q1', 'en', {
        expectedRevision: linked.newRevision,
      });
      const noDescription = await env.repository.removeDescription('Q1', 'en', {
        expectedRevision: noLabel.newRevision,
      });
      const noAlias = await env.repository.removeAlias('Q1', 'en', 0, {
        expectedRevision: noDescription.newRevision,
      });
      const noSitelink = await env.repository.removeSitelink('Q1', 'enwiki', {
        expectedRevision: noAlias.newRevision,
      });
      expect(noSitelink.entity).toMatchObject({
        labels: {},
        descriptions: {},
        aliases: {},
        sitelinks: {},
      });
      await expect(env.repository.searchEntities('label')).resolves.toEqual([]);
    } finally {
      await env.dispose();
    }
  }, 20_000);

  it('imports trusted ids, advances counters, and rejects collisions', async () => {
    const env = await environment();
    try {
      const imported = await env.repository.importEntity({
        id: 'Q42',
        type: 'item',
        labels: {},
        descriptions: {},
        aliases: {},
        claims: {},
        sitelinks: {},
        lastrevid: 7,
        modified: '2026-07-20T00:00:00.000Z',
      });
      expect(imported.newRevision).toBe(7);
      await expect(
        env.repository.importEntity(imported.entity),
      ).rejects.toBeInstanceOf(EntityAlreadyExistsError);
      await expect(env.repository.createItem()).resolves.toMatchObject({
        entityId: 'Q43',
      });
    } finally {
      await env.dispose();
    }
  }, 15_000);

  it('enforces database namespace and entity/quad size limits atomically', async () => {
    const env = await environment();
    try {
      const tiny = new TaprootRepository(env.db, {
        ...options,
        maxEntityBytes: 100,
      });
      await expect(
        tiny.createItem({
          labels: { en: { language: 'en', value: 'x'.repeat(200) } },
        }),
      ).rejects.toBeInstanceOf(EntityTooLargeError);
      await expect(env.repository.createItem()).resolves.toMatchObject({
        entityId: 'Q1',
      });
      const otherNamespace = new TaprootRepository(env.db, {
        baseIri: 'https://other.example',
      });
      await expect(otherNamespace.createItem()).rejects.toBeInstanceOf(
        SchemaMismatchError,
      );

      const huge = 'z'.repeat(1_400_000);
      await expect(
        env.repository.createItem({
          labels: { en: { language: 'en', value: huge } },
        }),
      ).rejects.toBeInstanceOf(QuadPatchTooLargeError);
      await expect(env.repository.getEntity('Q2')).rejects.toThrow();
    } finally {
      await env.dispose();
    }
  }, 30_000);

  it('permits only one competing edit from a revision', async () => {
    const env = await environment();
    try {
      const created = await env.repository.createItem();
      const outcomes = await Promise.allSettled([
        env.repository.setLabel('Q1', 'en', 'first', {
          expectedRevision: created.newRevision,
        }),
        env.repository.setLabel('Q1', 'en', 'second', {
          expectedRevision: created.newRevision,
        }),
      ]);
      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const rejection = outcomes.find(({ status }) => status === 'rejected');
      expect(rejection?.status).toBe('rejected');
      if (rejection?.status === 'rejected') {
        expect(rejection.reason).toBeInstanceOf(RevisionConflictError);
      }
      await expect(
        env.repository.listEntityRevisions('Q1'),
      ).resolves.toHaveLength(2);
    } finally {
      await env.dispose();
    }
  });

  it('enforces Property existence, datatype compatibility, and datatype immutability after use', async () => {
    const env = await environment();
    try {
      const property = await env.repository.createProperty({
        datatype: 'string',
      });
      const item = await env.repository.createItem();
      const missing: Statement = {
        id: 'Q1$missing',
        type: 'statement',
        text: 'The item has an unavailable property value.',
        rank: 'normal',
        mainsnak: {
          snaktype: 'somevalue',
          property: 'P99',
          datatype: 'string',
        },
        qualifiers: {},
        'qualifiers-order': [],
        references: [],
      };
      await expect(
        env.repository.addStatement('Q1', missing, {
          expectedRevision: item.newRevision,
        }),
      ).rejects.toBeInstanceOf(PropertyNotFoundError);
      const mismatch: Statement = {
        ...missing,
        id: 'Q1$mismatch',
        mainsnak: {
          snaktype: 'somevalue',
          property: 'P1',
          datatype: 'time',
        },
      };
      await expect(
        env.repository.addStatement('Q1', mismatch, {
          expectedRevision: item.newRevision,
        }),
      ).rejects.toBeInstanceOf(PropertyDatatypeMismatchError);
      const valid: Statement = {
        ...mismatch,
        id: 'Q1$valid',
        mainsnak: {
          snaktype: 'somevalue',
          property: 'P1',
          datatype: 'string',
        },
      };
      await env.repository.addStatement('Q1', valid, {
        expectedRevision: item.newRevision,
      });
      const changedProperty = structuredClone(property.entity);
      if (changedProperty.type !== 'property') throw new Error('test fixture');
      changedProperty.datatype = 'time';
      await expect(
        env.repository.replaceEntity('P1', changedProperty, {
          expectedRevision: property.newRevision,
          statementTexts: {},
        }),
      ).rejects.toBeInstanceOf(InvalidEntityError);
    } finally {
      await env.dispose();
    }
  }, 20_000);

  it('rolls JSON, revision, terms, and RDF back when RDF insertion fails', async () => {
    const env = await environment();
    try {
      const created = await env.repository.createItem({
        labels: { en: { language: 'en', value: 'before' } },
      });
      await env.db
        .prepare(
          `CREATE TRIGGER reject_taproot_rdf BEFORE INSERT ON rdf_quads BEGIN SELECT RAISE(ABORT, 'injected RDF failure'); END`,
        )
        .run();
      await expect(
        env.repository.setLabel('Q1', 'en', 'after', {
          expectedRevision: created.newRevision,
        }),
      ).rejects.toThrow(/injected RDF failure/);
      const stored = await env.repository.getEntity('Q1');
      expect(stored.entity.labels.en?.value).toBe('before');
      expect(stored.entity.lastrevid).toBe(1);
      await expect(
        env.repository.listEntityRevisions('Q1'),
      ).resolves.toHaveLength(1);
      await expect(env.repository.searchEntities('after')).resolves.toEqual([]);
    } finally {
      await env.dispose();
    }
  });

  it('soft deletes, restores, and redirects without losing canonical history', async () => {
    const env = await environment();
    try {
      const first = await env.repository.createItem({
        labels: { en: { language: 'en', value: 'first' } },
      });
      await env.repository.createItem({
        labels: { en: { language: 'en', value: 'target' } },
      });
      const deleted = await env.repository.softDeleteEntity('Q1', {
        expectedRevision: first.newRevision,
      });
      expect((await env.repository.getEntity('Q1')).deletedAt).not.toBeNull();
      expect(
        (await env.repository.getEntityRevision('Q1', deleted.newRevision))
          .deletedAt,
      ).not.toBeNull();
      await expect(env.repository.searchEntities('first')).resolves.toEqual([]);
      const restored = await env.repository.restoreEntity('Q1', {
        expectedRevision: deleted.newRevision,
      });
      expect((await env.repository.getEntity('Q1')).deletedAt).toBeNull();
      const redirected = await env.repository.redirectEntity('Q1', 'Q2', {
        expectedRevision: restored.newRevision,
      });
      expect((await env.repository.getEntity('Q1')).redirectTo).toBe('Q2');
      expect(redirected.newRevision).toBe(4);
      expect(await env.repository.resolveEntity('Q1')).toMatchObject({
        resolvedId: 'Q2',
        redirects: ['Q2'],
      });
      await expect(
        env.repository.redirectEntity('Q2', 'Q1', { expectedRevision: 1 }),
      ).rejects.toThrow(/cycle/iu);
      const property = await env.repository.createProperty({
        datatype: 'string',
      });
      await expect(
        env.repository.redirectEntity(property.entityId, 'Q2', {
          expectedRevision: property.newRevision,
        }),
      ).rejects.toThrow(/same entity type/iu);
    } finally {
      await env.dispose();
    }
  }, 30_000);

  it('provides attribution, immutable audit chains, cursors, batch commands, bulk I/O, and repair', async () => {
    const env = await environment();
    try {
      const created = await env.repository.createItem({
        labels: { en: { language: 'en', value: 'seed' } },
        attribution: {
          id: 'agent:curator',
          kind: 'agent',
          tool: 'gnolith-mcp',
        },
        editSummary: 'create seed',
        tags: ['agent', 'import'],
        requestId: 'request-1',
      });
      const edited = await env.repository.applyCommands(
        'Q1',
        [
          { type: 'set-label', language: 'en', value: 'oak' },
          { type: 'add-alias', language: 'en', value: 'tree' },
          { type: 'set-description', language: 'en', value: 'a plant' },
        ],
        {
          expectedRevision: created.newRevision,
          attribution: { id: 'user:1', kind: 'human', name: 'Editor' },
          tags: ['manual'],
          requestId: 'request-2',
        },
      );
      expect(edited.newRevision).toBe(2);
      const revisions = await env.repository.listEntityRevisionsPage('Q1', {
        limit: 1,
      });
      expect(revisions.items[0]).toMatchObject({
        attribution: { id: 'user:1', kind: 'human' },
        tags: ['manual'],
        parentHash: created.contentHash,
      });
      expect(revisions.cursor).not.toBeNull();
      expect(
        (
          await env.repository.listEntityRevisionsPage('Q1', {
            limit: 1,
            cursor: revisions.cursor!,
          })
        ).items[0]?.revision,
      ).toBe(1);
      const audit = await env.repository.listAuditEvents({
        entityId: 'Q1',
        limit: 10,
      });
      expect(audit.items).toHaveLength(2);
      expect(await env.repository.verifyAuditChain('Q1')).toMatchObject({
        valid: true,
      });
      await expect(
        env.db
          .prepare(
            `UPDATE taproot_entity_revisions SET edit_summary = 'tampered' WHERE entity_id = 'Q1'`,
          )
          .run(),
      ).rejects.toThrow(/immutable/);

      const exported = await env.repository.exportEntities();
      expect(exported.trim().split('\n')).toHaveLength(1);
      const entity = JSON.parse(
        exported,
      ) as import('../src/index.js').WikibaseEntity;
      entity.id = 'Q10';
      if (entity.type !== 'item') throw new Error('expected item');
      const bulk = await env.repository.importEntities([entity], {
        metadata: { attribution: { id: 'job:1', kind: 'import' } },
      });
      expect(bulk.failed).toHaveLength(0);
      expect(
        (await env.repository.listEntities({ limit: 1 })).cursor,
      ).not.toBeNull();

      const bulkProperty: import('../src/index.js').WikibaseEntity = {
        id: 'P5',
        type: 'property',
        datatype: 'string',
        labels: {},
        descriptions: {},
        aliases: {},
        claims: {},
        lastrevid: 1,
        modified: '2026-01-01T00:00:00.000Z',
      };
      const bulkItem: import('../src/index.js').WikibaseEntity = {
        id: 'Q30',
        type: 'item',
        labels: {},
        descriptions: {},
        aliases: {},
        sitelinks: {},
        claims: {
          P5: [
            {
              id: 'Q30$bulk',
              type: 'statement',
              text: 'Q30 has a planned dependency.',
              rank: 'normal',
              mainsnak: {
                snaktype: 'value',
                property: 'P5',
                datatype: 'string',
                datavalue: { type: 'string', value: 'planned dependency' },
              },
              qualifiers: {},
              'qualifiers-order': [],
              references: [],
            },
          ],
        },
        lastrevid: 1,
        modified: '2026-01-01T00:00:00.000Z',
      };
      const planned = await env.repository.importEntities([
        bulkItem,
        bulkProperty,
      ]);
      expect(planned.failed).toHaveLength(0);
      expect(planned.succeeded.map(({ entityId }) => entityId)).toEqual([
        'Q30',
        'P5',
      ]);

      await env.repository.createProperty({ id: 'P1', datatype: 'time' });
      const sharedSnak: Snak = {
        snaktype: 'value',
        property: 'P1',
        datatype: 'time',
        datavalue: {
          type: 'time',
          value: {
            time: '+2000-01-01T00:00:00Z',
            timezone: 0,
            before: 0,
            after: 0,
            precision: 11,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      };
      const sharedStatement = (id: `Q${number}`): Statement => ({
        id: `${id}$shared`,
        type: 'statement',
        text: `${id} shares the recorded time.`,
        rank: 'normal',
        mainsnak: structuredClone(sharedSnak),
        qualifiers: {},
        'qualifiers-order': [],
        references: [],
      });
      const firstShared = await env.repository.createItem({
        id: 'Q20',
        claims: { P1: [sharedStatement('Q20')] },
      });
      await env.repository.createItem({
        id: 'Q21',
        claims: { P1: [sharedStatement('Q21')] },
      });
      await env.repository.removeStatement('Q20', 'Q20$shared', {
        expectedRevision: firstShared.newRevision,
      });
      expect(await env.repository.inspectEntityIntegrity('Q21')).toMatchObject({
        valid: true,
      });

      await env.db
        .prepare(`DELETE FROM taproot_terms WHERE entity_id = 'Q1'`)
        .run();
      expect(await env.repository.inspectEntityIntegrity('Q1')).toMatchObject({
        valid: false,
      });
      await expect(
        env.repository.repairEntityProjection('Q1', {
          attribution: { id: 'system:repair', kind: 'system' },
        }),
      ).rejects.toBeInstanceOf(RevisionConflictError);
      const reverted = await env.repository.revertEntity('Q1', 1, {
        expectedRevision: edited.newRevision,
        statementTexts: {},
        editSummary: 'revert to seed',
      });
      expect(reverted.entity.labels.en?.value).toBe('seed');
      expect(reverted.newRevision).toBe(3);
    } finally {
      await env.dispose();
    }
  }, 30_000);
});

async function insertD1PagedCorpus(
  db: D1DatabaseLike,
  source: 'current' | 'historical',
): Promise<void> {
  const page = PERSISTED_STATEMENT_TEXT_PAGE_SIZE;
  if (source === 'current') {
    await db.batch(
      Array.from({ length: page + 1 }, (_, index) => {
        const id = `Q${String(index + 1).padStart(4, '0')}`;
        return db
          .prepare(
            `INSERT INTO taproot_entities(
               entity_id, entity_type, datatype, revision, entity_json, modified_at
             ) VALUES (?, 'item', NULL, 1, ?, '2026-01-01T00:00:00.000Z')`,
          )
          .bind(
            id,
            d1PagedEntityJson(id, 1, index === page ? '\u00a0' : undefined),
          );
      }),
    );
    return;
  }
  const id = 'Q1';
  await db
    .prepare(
      `INSERT INTO taproot_entities(
         entity_id, entity_type, datatype, revision, entity_json, modified_at
       ) VALUES (?, 'item', NULL, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .bind(id, page + 1, d1PagedEntityJson(id, page + 1))
    .run();
  await db.batch(
    Array.from({ length: page + 1 }, (_, index) => {
      const revision = index + 1;
      return db
        .prepare(
          `INSERT INTO taproot_entity_revisions(
             entity_id, revision, entity_json, tags_json, event_id,
             content_hash, created_at
           ) VALUES (?, ?, ?, '[]', ?, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .bind(
          id,
          revision,
          d1PagedEntityJson(
            id,
            revision,
            index === page ? '\u00a0' : undefined,
          ),
          `event-${revision}`,
          `hash-${revision}`,
        );
    }),
  );
}

function d1PagedEntityJson(
  id: string,
  revision: number,
  statementText?: string,
): string {
  return JSON.stringify({
    id,
    type: 'item',
    labels: {},
    descriptions: {},
    aliases: {},
    claims:
      statementText === undefined
        ? {}
        : {
            P1: [
              {
                id: `${id}$later-page`,
                type: 'statement',
                text: statementText,
              },
            ],
          },
    sitelinks: {},
    lastrevid: revision,
    modified: '2026-01-01T00:00:00.000Z',
  });
}
