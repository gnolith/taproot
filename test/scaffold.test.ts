import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidEntityError, parseEntityJson } from '../src/index.js';
import { TaprootRepository } from '../src/repository.js';

describe('package release guard', () => {
  it('is a public package backed only by registry dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      name: string;
      private: boolean;
      version: string;
      dependencies: Record<string, string>;
      publishConfig: { access: string; provenance: boolean };
    };
    expect(manifest).toMatchObject({
      name: '@gnolith/taproot',
      private: false,
      version: '0.4.1',
      publishConfig: { access: 'public', provenance: true },
    });
    expect(manifest.dependencies['@gnolith/diamond']).toBe('0.4.1');
    expect(Object.values(manifest.dependencies)).not.toContainEqual(
      expect.stringMatching(/^(?:file:|link:)/),
    );
  });

  it('locks the qualified Diamond and Qdrant runtime coordinates', () => {
    const root = new URL('..', import.meta.url);
    const consumer = readFileSync(
      new URL('scripts/consumer-smoke.mjs', root),
      'utf8',
    );
    const qdrant = readFileSync(
      new URL('scripts/qdrant-conformance.mjs', root),
      'utf8',
    );
    expect(consumer).toContain("diamondInstances[0] !== '0.4.1'");
    expect(consumer).not.toContain('DIAMOND_TARBALL');
    expect(qdrant).toContain(
      'qdrant/qdrant:v1.18.2@sha256:da65a06bc75e42702f80c992b99c5144b0fbd675ae7a96d2991de0bf957b7071',
    );
    expect(qdrant).toContain("const PLATFORM = 'linux/amd64'");
  });

  it('rejects malformed input and empty command batches before touching D1', async () => {
    expect(() => parseEntityJson('{not-json')).toThrow(InvalidEntityError);
    expect(() => parseEntityJson('{"id":"Q1"}')).toThrow(InvalidEntityError);

    const repository = new TaprootRepository({} as never, {
      baseIri: 'https://knowledge.example',
    });
    await expect(
      repository.applyCommands('Q1', [], { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITY' });
  });
});
