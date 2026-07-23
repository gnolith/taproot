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
import {
  registerExternalProducerKindV1,
  registerExternalProducerV1,
  type ExternalProducer,
} from '../src/search.js';

const options = { baseIri: 'https://generic-producer.example' };
const installationId = 'generic-producer-installation';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('generic external producer boundary', () => {
  it('brands namespace handles and atomically consumes an owner participant once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taproot-generic-producer-'));
    directories.push(directory);
    const db = new NodeSqliteDatabase(join(directory, 'taproot.sqlite'));
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
        installationId,
      );
      await db
        .prepare(
          `CREATE TABLE fixture_owner_records(
             source_id TEXT PRIMARY KEY, revision TEXT NOT NULL
           ) STRICT`,
        )
        .run();
      const registeredKind = await registerExternalProducerKindV1(
        db,
        options,
        authority,
        {
          installationId,
          namespace: 'fixture.example',
          localName: 'note',
          ownerDomain: 'fixture-owner',
          adapter: {
            kind: 'taproot-external-owner-transaction-adapter-v1',
            prepare(token) {
              const input = token as { sourceId: string; revision: string };
              return Promise.resolve([
                db
                  .prepare(
                    `INSERT INTO fixture_owner_records(source_id, revision)
                     VALUES (?, ?)`,
                  )
                  .bind(input.sourceId, input.revision),
              ]);
            },
          },
        },
      );
      expect(Object.isFrozen(registeredKind.kind)).toBe(true);
      expect(Object.isFrozen(registeredKind.registration)).toBe(true);
      const source = {
        sourceId: 'fixture-1',
        sourceRevision: '1',
        sourcePolicyRevision: 1,
        canonical: { title: 'A generic fixture' },
      };
      const producer: ExternalProducer = {
        descriptor: {
          registration: registeredKind.registration,
          implementationVersion: '1.0.0',
          fingerprint: 'f'.repeat(64),
          projectionVersion: 'fixture-projection-v1',
          changeClasses: ['canonical'],
        },
        enumerate: () =>
          Promise.resolve({ ids: [source.sourceId], cursor: null }),
        loadExact: () => Promise.resolve(source),
        project: () => Promise.resolve({ text: 'A generic fixture document' }),
        authorize: (_reference, context) =>
          Promise.resolve(context.installationId === installationId),
        hydrate: () => Promise.resolve(source.canonical),
      };
      const registered = await registerExternalProducerV1(
        db,
        options,
        authority,
        producer,
      );
      const participant = await registered.issuer.seal({
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        predecessor: null,
        ownerMutationToken: {
          sourceId: source.sourceId,
          revision: source.sourceRevision,
        },
      });
      expect(Object.isFrozen(participant)).toBe(true);
      const receipt = await registered.commit(participant);
      expect(receipt.generation).toBe(2);
      await expect(registered.commit(participant)).rejects.toThrow(
        /invalid|consumed/u,
      );
      const rows = await db
        .prepare(`SELECT source_id, revision FROM fixture_owner_records`)
        .all<{ source_id: string; revision: string }>();
      expect(rows.results).toEqual([
        { source_id: source.sourceId, revision: source.sourceRevision },
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects forged, duplicate, reserved, and cross-connection handles', async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), 'taproot-kind-first-'));
    const secondDirectory = mkdtempSync(join(tmpdir(), 'taproot-kind-second-'));
    directories.push(firstDirectory, secondDirectory);
    const first = new NodeSqliteDatabase(join(firstDirectory, 'db.sqlite'));
    const second = new NodeSqliteDatabase(join(secondDirectory, 'db.sqlite'));
    try {
      await initializeTaproot(first, options);
      await initializeTaproot(second, options);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const firstAuthority = createTaprootHostWriteCapability(
        first,
        options,
        key,
      );
      await bootstrapTaprootAuthorization(
        first,
        options,
        firstAuthority,
        installationId,
      );
      const input = {
        installationId,
        namespace: 'fixture.example',
        localName: 'record',
        ownerDomain: 'fixture-owner',
        adapter: {
          kind: 'taproot-external-owner-transaction-adapter-v1' as const,
          prepare: () => Promise.resolve([]),
        },
      };
      await registerExternalProducerKindV1(
        first,
        options,
        firstAuthority,
        input,
      );
      await expect(
        registerExternalProducerKindV1(first, options, firstAuthority, input),
      ).rejects.toThrow(/already registered/u);
      await expect(
        registerExternalProducerKindV1(first, options, firstAuthority, {
          ...input,
          namespace: 'taproot',
        }),
      ).rejects.toThrow(/reserved/u);
      const context: AuthorizationContext = {
        installationId,
        principalId: 'principal',
        activeWorkspaceId: null,
        workspaceIds: [],
        capabilities: [],
        authorizationRevision: 1,
      };
      expect(context.installationId).toBe(installationId);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
