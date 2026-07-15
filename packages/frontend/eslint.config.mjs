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
    // Components/pages: these two rules fight React's shape — hooks (and the
    // values derived for them) must be declared before any early return, and a
    // component legitimately returns a loading element in one branch and content
    // in another.
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
    rules: {
      'unicorn/no-declarations-before-early-exit': 'off',
      'sonarjs/function-return-type': 'off',
    },
  },
  {
    // Machine-enforced vendor isolation: only lib/monitoring.ts imports the Sentry
    // vendor. Everything else uses the neutral Monitoring surface, so the vendor
    // (or Next) can be swapped by rewriting that one file.
    files: ['**/*.{ts,tsx}'],
    // next-env.d.ts is Next-generated (references ./.next/types/...) — not ours to rewrite.
    ignores: ['src/lib/monitoring.ts', 'next-env.d.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*'],
              message: 'Import the neutral Monitoring surface (lib/monitoring.ts), not the Sentry vendor.',
            },
            // Absolute imports only: every internal import uses the `@frontend/*` alias,
            // never a relative `./` or `../`. Cross-package stays `@mocco/*`.
            {
              regex: '^\\.',
              message: 'Use the @frontend/* absolute alias, not a relative ./ or ../ path.',
            },
            // `@backend/*` is a resolution-only cross-map (it lets the bundler resolve the
            // backend package's own internal imports); the frontend must reach the backend
            // only through its public `@mocco/backend/*` exports, never its internals.
            {
              group: ['@backend/*'],
              message: 'Import the backend via its public @mocco/backend/* exports, not @backend/* internals.',
            },
          ],
        },
      ],
    },
  },
  {
    // monitoring.ts is exempt from the Sentry-vendor ban above (it IS the vendor
    // boundary) but still holds to the no-relative and no-@backend-internals rules.
    files: ['src/lib/monitoring.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^\\.', message: 'Use the @frontend/* absolute alias, not a relative ./ or ../ path.' },
            {
              group: ['@backend/*'],
              message: 'Import the backend via its public @mocco/backend/* exports, not @backend/* internals.',
            },
          ],
        },
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
