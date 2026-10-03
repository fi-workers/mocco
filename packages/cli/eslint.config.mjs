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
  // @mocco/common (private) and the dev runner's tsx are bundled or dev-only: tsup
  // bundles @mocco/common into dist, so it is a devDependency.
  {
    files: ['src/**/*.ts', 'bin/**/*.mjs'],
    rules: { 'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }] },
  },
];
