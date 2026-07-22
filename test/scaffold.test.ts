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
      version: '0.4.0',
      publishConfig: { access: 'public', provenance: true },
    });
    expect(manifest.dependencies['@gnolith/diamond']).toBe('0.4.0');
    expect(Object.values(manifest.dependencies)).not.toContainEqual(
      expect.stringMatching(/^(?:file:|link:)/),
    );
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
