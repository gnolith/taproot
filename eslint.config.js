import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const typedFiles = [
  'src/**/*.ts',
  'test/**/*.ts',
  'examples/**/*.ts',
  'vitest.config.ts',
];

export default tseslint.config(
  { ignores: ['coverage/**', 'dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Request: 'readonly',
      },
    },
  },
);
