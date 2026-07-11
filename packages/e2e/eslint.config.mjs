import prettier from 'eslint-config-prettier/flat';

import { createBaseConfig } from '../../eslint.config.base.mjs';

export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // The whole package is test/config tooling — no production code — so
    // importing devDependencies (@playwright/test) is expected everywhere.
    files: ['**/*.ts'],
    rules: { 'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }] },
  },
  prettier,
];
