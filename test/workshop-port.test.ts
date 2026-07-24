import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  commitAuthorizationBootstrapV1,
  createTaprootHostWriteCapability,
  createTaprootWorkshopPortV1,
  initializeTaproot,
  KNOWLEDGE_POLICY_CAPABILITY,
  KNOWLEDGE_WRITE_CAPABILITY,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationBootstrapOwnerV1,
  type Statement,
  type TaprootHostWriteCapability,
} from '../src/index.js';

const options = { baseIri: 'https://workshop-port.example' };
const installationId = 'workshop-port-installation';
const KNOWLEDGE_READ_CAPABILITY = 'knowledge:read';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('TaprootWorkshopPortV1', () => {
  for (const runtime of [nativeRuntime(), workerdRuntime()]) {
    it(`provides bounded, non-disclosing owner reads and live policy resolution across ${runtime.name} restart`, async () => {
      let env = await runtime.open();
      try {
        await initializeTaproot(env.db, options);
        let authority = await hostAuthority(env.db);
        await bootstrap(env.db, authority);
        let port = await createTaprootWorkshopPortV1(
          env.db,
          options,
          authority,
          { installationId },
        );
        let context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        expect(context).toMatchObject({
          authorizationRevision: 1,
          workspaceIds: ['workspace-1'],
          capabilities: [
            KNOWLEDGE_POLICY_CAPABILITY,
            KNOWLEDGE_READ_CAPABILITY,
            KNOWLEDGE_WRITE_CAPABILITY,
          ],
        });
        const property = await port.createProperty(
          { id: 'P1', datatype: 'string' },
          { idempotencyKey: 'create-property-1' },
          context,
        );
        context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        await expect(
          port.createProperty(
            { id: 'P1', datatype: 'string' },
            { idempotencyKey: 'create-property-1' },
            context,
          ),
        ).resolves.toEqual(property);
        await port.createItem(
          { id: 'Q1' },
          { idempotencyKey: 'create-item-1' },
          context,
        );
        context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        const statement = fixtureStatement();
        const authoredStatementText = 'The item has the authored value.';
        const authoredTexts = [
          'Set the English label in the same atomic edit.',
          authoredStatementText,
        ];
        await port.mutateEntity(
          'Q1',
          [
            {
              command: {
                type: 'set-label',
                language: 'en',
                value: 'Atomic edit',
              },
              authoredText: authoredTexts[0]!,
            },
            {
              command: { type: 'add-statement', statement },
              authoredText: authoredTexts[1]!,
            },
          ],
          { expectedRevision: 1, idempotencyKey: 'add-statement-1' },
          context,
        );
        context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        const beforeIdenticalLabel = await canonicalWriteState(env.db, 'Q1');
        const identicalRequest = [
          {
            command: {
              type: 'set-label' as const,
              language: 'en',
              value: 'Atomic edit',
            },
            authoredText: 'Retry the already-current English label.',
          },
        ];
        const [identicalLabel, concurrentRetry] = await Promise.all([
          port.mutateEntity(
            'Q1',
            identicalRequest,
            {
              expectedRevision: 2,
              idempotencyKey: 'identical-label-1',
            },
            context,
          ),
          port.mutateEntity(
            'Q1',
            identicalRequest,
            {
              expectedRevision: 2,
              idempotencyKey: 'identical-label-1',
            },
            context,
          ),
        ]);
        expect(identicalLabel).toEqual(concurrentRetry);
        expect(identicalLabel).toMatchObject({
          entityId: 'Q1',
          previousRevision: 2,
          newRevision: 2,
        });
        await expect(canonicalWriteState(env.db, 'Q1')).resolves.toEqual(
          beforeIdenticalLabel,
        );
        const resourceInput = {
          id: 'resource-1',
          itemId: 'Q1' as const,
          title: 'First',
          payload: { kind: 'inline-text' as const, text: 'first body' },
          mediaType: 'text/plain',
          integrity: await integrity('first body'),
        };
        await port.createResource(
          resourceInput,
          { idempotencyKey: 'create-resource-1' },
          context,
        );
        context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        await port.updateResource(
          'resource-1',
          1,
          {
            ...resourceInput,
            title: 'Second',
            payload: { kind: 'inline-text', text: 'second body' },
            integrity: await integrity('second body'),
          },
          { idempotencyKey: 'update-resource-1' },
          context,
        );
        context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        const annotationInput = {
          id: 'annotation-1',
          body: { kind: 'text' as const, text: 'first note' },
          target: {
            kind: 'resource' as const,
            sourceId: 'resource-1',
          },
        };
        await port.createAnnotation(
          annotationInput,
          { idempotencyKey: 'create-annotation-1' },
          context,
        );
        context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        await port.updateAnnotation(
          'annotation-1',
          1,
          {
            ...annotationInput,
            body: { kind: 'text', text: 'second note' },
          },
          { idempotencyKey: 'update-annotation-1' },
          context,
        );
        context = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });

        const firstPage = await port.resourceHistory(
          'resource-1',
          { limit: 1 },
          context,
        );
        expect(firstPage.items.map(({ revision }) => revision)).toEqual([2]);
        expect(firstPage.cursor).toBeTruthy();
        await expect(
          port.resourceHistory(
            'resource-1',
            { limit: 1, cursor: firstPage.cursor! },
            context,
          ),
        ).resolves.toMatchObject({ items: [{ revision: 1 }], cursor: null });
        await expect(
          port.hydrateResource('resource-1', 1, context),
        ).resolves.toEqual(new TextEncoder().encode('first body'));
        await expect(
          port.annotationHistory('annotation-1', { limit: 10 }, context),
        ).resolves.toMatchObject({
          items: [{ revision: 2 }, { revision: 1 }],
          cursor: null,
        });
        await expect(
          port.statementHistory(statement.id, { limit: 10 }, context),
        ).resolves.toMatchObject({
          items: [
            {
              entityId: 'Q1',
              entityRevision: 2,
              statement: { id: statement.id },
            },
          ],
        });
        await expect(
          port.statementRevision(statement.id, 2, context),
        ).resolves.toMatchObject({
          statement: { id: statement.id, text: authoredStatementText },
          revision: {
            editSummary: JSON.stringify(authoredTexts),
            attribution: { id: 'principal-1', kind: 'human' },
          },
        });
        const forged = {
          ...context,
          principalId: 'principal-2',
          activeWorkspaceId: null,
          workspaceIds: [],
        };
        await expect(
          port.resourceRevision('resource-1', 1, forged),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
        await expect(
          port.statementRevision('Q1$missing', 2, context),
        ).rejects.toThrow('Authorization denied');

        const beforeRestartRetry = await canonicalWriteState(env.db, 'Q1');
        await env.close();
        env = await runtime.reopen();
        authority = await hostAuthority(env.db);
        port = await createTaprootWorkshopPortV1(env.db, options, authority, {
          installationId,
        });
        const restarted = await port.resolveAuthorization({
          principalId: 'principal-1',
          activeWorkspaceId: 'workspace-1',
        });
        await expect(
          port.mutateEntity(
            'Q1',
            identicalRequest,
            {
              expectedRevision: 2,
              idempotencyKey: 'identical-label-1',
            },
            restarted,
          ),
        ).resolves.toEqual(identicalLabel);
        await expect(canonicalWriteState(env.db, 'Q1')).resolves.toEqual(
          beforeRestartRetry,
        );
        await expect(
          port.createProperty(
            { id: 'P1', datatype: 'string' },
            { idempotencyKey: 'create-property-1' },
            restarted,
          ),
        ).resolves.toEqual(property);
        await expect(
          port.resourceRevision('resource-1', 1, restarted),
        ).resolves.toMatchObject({ id: 'resource-1', revision: 1 });

        await port.mutateEntity(
          'Q1',
          [
            {
              command: {
                type: 'set-label',
                language: 'en',
                value: 'revoked fence',
              },
              authoredText: 'Set the English label to revoked fence',
            },
          ],
          {
            expectedRevision: 2,
            idempotencyKey: 'set-label-1',
          },
          restarted,
        );
        await expect(
          port.resourceRevision('resource-1', 1, restarted),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
        await expect(
          port.resolveAuthorization({
            principalId: 'principal-1',
            activeWorkspaceId: 'workspace-1',
          }),
        ).resolves.toMatchObject({
          authorizationRevision: restarted.authorizationRevision + 1,
        });
      } finally {
        await env.close();
      }
    }, 120_000);
  }
});

async function canonicalWriteState(db: D1DatabaseLike, entityId: string) {
  const result = await db
    .prepare(
      `SELECT
         (SELECT revision FROM taproot_entities WHERE entity_id = ?) AS revision,
         (SELECT COUNT(*) FROM taproot_entity_revisions WHERE entity_id = ?) AS revisions,
         (SELECT COUNT(*) FROM taproot_audit_events WHERE entity_id = ?) AS audits,
         (SELECT COUNT(*) FROM taproot_rdf_ownership WHERE entity_id = ?) AS ownership,
         (SELECT COUNT(*) FROM rdf_quads) AS quads,
         (SELECT COUNT(*) FROM taproot_unified_search_source_events) AS source_events,
         (SELECT authorization_revision FROM taproot_installation_authorization
          WHERE singleton = 1) AS authorization_revision,
         (SELECT search_generation FROM taproot_installation_authorization
          WHERE singleton = 1) AS search_generation,
         (SELECT COALESCE(MAX(source_watermark_sequence), 0)
          FROM taproot_search_corpora) AS source_watermark,
         (SELECT COALESCE(MAX(enqueued_sequence), 0)
          FROM taproot_search_kind_checkpoints) AS enqueued_watermark,
         (SELECT COALESCE(MAX(applied_sequence), 0)
          FROM taproot_search_kind_checkpoints) AS applied_watermark`,
    )
    .bind(entityId, entityId, entityId, entityId)
    .all<Record<string, unknown>>();
  return result.results[0];
}

async function bootstrap(
  db: D1DatabaseLike,
  authority: TaprootHostWriteCapability,
): Promise<void> {
  const owner = await registerAuthorizationBootstrapOwnerV1(
    db,
    options,
    authority,
    {
      installationId,
      ownerRegistrationId: 'workshop-owner-v1',
      adapter: {
        kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
        prepare: () =>
          Promise.resolve({ statements: [], receipt: { version: 1 } }),
      },
    },
  );
  const participant = await prepareAuthorizationBootstrapV1(
    db,
    options,
    authority,
    {
      installationId,
      baseIri: options.baseIri,
      principalId: 'principal-1',
      workspaceId: 'workspace-1',
      grants: [
        KNOWLEDGE_POLICY_CAPABILITY,
        KNOWLEDGE_READ_CAPABILITY,
        KNOWLEDGE_WRITE_CAPABILITY,
      ],
      idempotencyKey: 'workshop-bootstrap-v1',
    },
  );
  await commitAuthorizationBootstrapV1(
    participant,
    await owner.seal(participant, {}),
  );
}

async function hostAuthority(
  db: D1DatabaseLike,
): Promise<TaprootHostWriteCapability> {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return createTaprootHostWriteCapability(db, options, key);
}

function fixtureStatement(): Statement {
  return {
    id: 'Q1$workshop',
    type: 'statement',
    text: 'Workshop statement',
    rank: 'normal',
    mainsnak: {
      snaktype: 'value',
      property: 'P1',
      datatype: 'string',
      datavalue: { type: 'string', value: 'workshop' },
    },
    qualifiers: {},
    'qualifiers-order': [],
    references: [],
  };
}

async function integrity(text: string) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return {
    algorithm: 'sha256' as const,
    digest: [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    byteLength: bytes.byteLength,
  };
}

interface TestEnvironment {
  db: D1DatabaseLike;
  close(): Promise<void>;
}

interface TestRuntime {
  name: string;
  open(): Promise<TestEnvironment>;
  reopen(): Promise<TestEnvironment>;
}

function nativeRuntime(): TestRuntime {
  let path = '';
  return {
    name: 'native SQLite',
    open() {
      const directory = mkdtempSync(join(tmpdir(), 'taproot-workshop-port-'));
      directories.push(directory);
      path = join(directory, 'taproot.sqlite');
      return Promise.resolve(environment(new NodeSqliteDatabase(path)));
    },
    reopen: () => Promise.resolve(environment(new NodeSqliteDatabase(path))),
  };
}

function workerdRuntime(): TestRuntime {
  let directory = '';
  let databaseId = crypto.randomUUID();
  return {
    name: 'real Workerd D1',
    async open() {
      directory = mkdtempSync(join(tmpdir(), 'taproot-workshop-workerd-'));
      directories.push(directory);
      databaseId = crypto.randomUUID();
      return workerdEnvironment(directory, databaseId);
    },
    reopen: () => workerdEnvironment(directory, databaseId),
  };
}

function environment(
  db: D1DatabaseLike & { close(): Promise<void> },
): TestEnvironment {
  return {
    db,
    close: () => db.close(),
  };
}

async function workerdEnvironment(directory: string, databaseId: string) {
  const miniflare = new Miniflare({
    modules: true,
    script: `export default { fetch() { return new Response("ok"); } }`,
    d1Persist: directory,
    d1Databases: { DB: databaseId },
  });
  const db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
  return {
    db,
    close: () => miniflare.dispose(),
  };
}
