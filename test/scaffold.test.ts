import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package scaffold', () => {
  it('cannot be published before an API is ready', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string; private: boolean; version: string };
    expect(manifest).toMatchObject({
      name: '@gnolith/taproot',
      private: true,
      version: '0.0.0',
    });
  });
});
