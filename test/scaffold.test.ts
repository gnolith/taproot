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
      version: '0.5.0',
      publishConfig: { access: 'public', provenance: true },
    });
    expect(manifest.dependencies['@gnolith/diamond']).toBe('0.5.0');
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
    const materializer = readFileSync(
      new URL('scripts/materialize-diamond.mjs', root),
      'utf8',
    );
    expect(consumer).toContain("uniqueVersions[0] !== '0.5.0'");
    expect(consumer).toContain('DIAMOND_TARBALL');
    expect(qdrant).toContain(
      'qdrant/qdrant:v1.18.2@sha256:da65a06bc75e42702f80c992b99c5144b0fbd675ae7a96d2991de0bf957b7071',
    );
    expect(qdrant).toContain("const PLATFORM = 'linux/amd64'");
    expect(materializer).toContain('e82f58ba8028ff9c16a34f4b8a9a2bc356495b64');
    expect(materializer).toContain('Diamond tarball integrity mismatch');
  });

  it('binds deterministic runtime SBOM evidence to package and source hashes', () => {
    const root = new URL('..', import.meta.url);
    const candidate = readFileSync(
      new URL('scripts/release-candidate.mjs', root),
      'utf8',
    );
    const releaseCheck = readFileSync(
      new URL('scripts/release-check.mjs', root),
      'utf8',
    );
    const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    expect(candidate).toContain("'--omit=dev'");
    expect(candidate).toContain('gnolith:package:integrity');
    expect(candidate).toContain('gnolith:source:commit');
    expect(candidate).toContain('gnolith:source:tree');
    expect(candidate).toContain('SHA256SUMS');
    expect(releaseCheck).toContain('release candidate inventories differ');
    expect(releaseCheck).toContain('is not deterministic');
    expect(ci).toContain('taproot-release-candidate-${{ github.sha }}');
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
