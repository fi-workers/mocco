import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig, houseStyle, restrictedSyntax } from '../../eslint.config.base.mjs';

export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Machine-enforced vendor isolation: only auth/ may touch the provider.
    // Everything else consumes the neutral surface (auth/AuthService.ts, auth/WorkspaceService.ts).
    files: ['**/*.ts'],
    ignores: ['src/domain/auth/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/auth/provider', '*/auth/provider'],
              message:
                'Import the neutral auth surface (auth/AuthService.ts, auth/WorkspaceService.ts) instead of the vendor provider.',
            },
            {
              group: ['better-auth', 'better-auth/*'],
              message:
                'The auth vendor is only importable inside auth/. Use the neutral surface (auth/AuthService.ts, auth/WorkspaceService.ts).',
            },
            {
              // Absolute imports: reach across directories via the #backend/* subpath,
              // never by climbing ../. Same-directory ./ siblings stay relative (they
              // survive a file moving within its folder); cross-package stays @mocco/*.
              regex: '^\\.\\./',
              message: 'Use the #backend/* absolute import instead of a ../ parent climb (same-dir ./ is fine).',
            },
          ],
        },
      ],
    },
  },
  {
    // auth/ is excluded from the vendor block above (it IS the vendor boundary and
    // legitimately imports ./provider), but it still holds to the no-parent-climb rule.
    files: ['src/domain/auth/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./',
              message: 'Use the #backend/* absolute import instead of a ../ parent climb (same-dir ./ is fine).',
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
    ignores: ['src/infra/config/env.ts'],
    rules: {
      // Overrides base's no-restricted-syntax (arrays don't merge) — keep the shared
      // bans (enum, for-of, …) and add the backend-only process.env ban.
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
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
    // Tests may import the provider directly to probe vendor behavior on pglite.
    files: ['**/*.{test,spec}.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
  houseStyle,
];
