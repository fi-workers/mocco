import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier/flat';

import { createBaseConfig, houseStyle } from '../../eslint.config.base.mjs';

export default [
  { ignores: ['dist/**'] },
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  airbnbPlugins.node,
  ...airbnb.node.recommended,
  prettier,
  houseStyle,
  // tsup bundles @mocco/common (private) into dist, so it is a devDependency.
  {
    files: ['src/**/*.ts'],
    rules: { 'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }] },
  },
  // The tests are about addresses and talk plain HTTP to local fixture servers on purpose.
  {
    files: ['src/**/*.test.ts', 'src/testing/**'],
    rules: {
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'unicorn/prefer-https': 'off',
    },
  },
  // The bin's source carries its shebang (tsup keeps it for that entry only); the rule
  // looks for `src/cli.ts` in package.json's `bin`, which names the built file.
  { files: ['src/cli.ts'], rules: { 'n/hashbang': 'off' } },
  // Vendor isolation: only the HTTP check talks to undici.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/http-check.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'undici', message: 'Only src/http-check.ts may import undici.' }] },
      ],
    },
  },
];
