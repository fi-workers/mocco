import { plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig } from '../../eslint.config.base.mjs';

// eslint-plugin-react(7.37.5) is excluded: no ESLint 10 support (context.getFilename removed).
// TS replaces prop-types, and the core rules-of-hooks is covered by react-hooks v7.
export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  airbnbPlugins.next,
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
  },
  {
    // App sources only (config files have no type info → exclude type-aware rules)
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    rules: {
      // Allow async functions in React event handlers (onClick etc.) — idiomatic pattern.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  prettier,
];
