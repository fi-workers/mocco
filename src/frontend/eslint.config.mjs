import nextPlugin from '@next/eslint-plugin-next';
import eslintReact from '@eslint-react/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig } from '../../eslint.config.base.mjs';

// React lint stack (ESLint 10 era):
// - @eslint-react: type-aware React rules — the modern replacement for eslint-plugin-react
//   (which lacks ESLint 10 support; prop-types are covered by TS anyway)
// - react-hooks v7 recommended-latest: rules-of-hooks + React Compiler-powered diagnostics
// - @next/eslint-plugin-next: Next.js rules incl. Core Web Vitals (previously registered but not enabled)
// - jsx-a11y strict: accessibility
export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  nextPlugin.configs['core-web-vitals'],
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['**/*.{ts,tsx}'],
    ...eslintReact.configs['recommended-type-checked'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: jsxA11y.flatConfigs.strict.rules,
  },
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
