import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig } from '../../eslint.config.base.mjs';

export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Machine-enforced vendor isolation: only auth/ may touch the provider.
    // Everything else consumes the neutral surface (auth/session.ts).
    files: ['**/*.ts'],
    ignores: ['auth/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/auth/provider', '*/auth/provider'],
              message: 'Import the neutral auth surface (auth/session.ts) instead of the vendor provider.',
            },
            {
              group: ['better-auth', 'better-auth/*'],
              message: 'The auth vendor is only importable inside auth/. Use the neutral surface (auth/session.ts).',
            },
            {
              group: ['**/auth/testing', '*/auth/testing'],
              message: 'auth/testing is a test-only seam. Production code uses the neutral surface (auth/index.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    // Env access is centralized: config/env.ts is the only process.env reader
    // (zod-parsed, lazy). Never read process.env inline.
    files: ['**/*.ts'],
    ignores: ['config/env.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message: 'Read env through getEnv() (config/env.ts) — the single, zod-validated env surface.',
        },
      ],
    },
  },
  airbnbPlugins.node,
  ...airbnb.node.recommended,
  {
    // Tests may use the auth/testing seam (and, via it, the provider) to bind pglite.
    files: ['**/*.{test,spec}.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
];
