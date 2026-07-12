import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier/flat';

import { createBaseConfig, houseStyle } from '../../eslint.config.base.mjs';

export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  airbnbPlugins.node,
  ...airbnb.node.recommended,
  prettier,
  houseStyle,
];
