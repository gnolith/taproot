import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@gnolith/taproot': fileURLToPath(
        new URL('./src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/adapters-cloudflare-d1-compatible.ts',
        'src/adapters-d1-compatible.ts',
        'src/adapters-qdrant.ts',
        'src/adapters-sqlite-vector.ts',
        'src/sqlite-types.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 70,
        lines: 75,
      },
    },
  },
});
