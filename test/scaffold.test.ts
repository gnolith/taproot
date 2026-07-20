import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package release guard', () => {
  it('stays private until the registry Diamond dependency is available', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string; private: boolean; version: string };
    expect(manifest).toMatchObject({
      name: '@gnolith/taproot',
      private: true,
      version: '0.1.0-rc.0',
    });
  });
});
