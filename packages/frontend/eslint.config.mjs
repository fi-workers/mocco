import nextPlugin from '@next/eslint-plugin-next';
import eslintReact from '@eslint-react/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig, houseStyle } from '../../eslint.config.base.mjs';

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
    files: ['src/pages/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
    rules: {
      // Allow async functions in React event handlers (onClick etc.) — idiomatic pattern.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    // Machine-enforced vendor isolation: only lib/monitoring.ts imports the Sentry
    // vendor. Everything else uses the neutral Monitoring surface, so the vendor
    // (or Next) can be swapped by rewriting that one file.
    files: ['**/*.{ts,tsx}'],
    ignores: ['src/lib/monitoring.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*'],
              message: 'Import the neutral Monitoring surface (lib/monitoring.ts), not the Sentry vendor.',
            },
            // Absolute imports: reach across directories via the `@/` alias, never
            // by climbing `../`. Same-directory `./` siblings stay relative (they
            // survive a file moving within its folder). `@/` maps to this package's
            // src; cross-package still uses `@mocco/*`.
            {
              regex: '^\\.\\./',
              message: 'Use the @/ absolute alias instead of a ../ parent import.',
            },
          ],
        },
      ],
    },
  },
  {
    // monitoring.ts is exempt from the Sentry-vendor ban above (it IS the vendor
    // boundary) but still holds to the no-parent-import rule.
    files: ['src/lib/monitoring.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^\\.\\./', message: 'Use the @/ absolute alias instead of a ../ parent import.' }] },
      ],
    },
  },
  {
    // Pages Router route files are named by the router — `pages/index.tsx` is the
    // home route, not a re-export barrel. Exempt route index files from the ban.
    files: ['src/pages/**/index.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
  houseStyle,
];
