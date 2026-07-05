import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig } from '../../eslint.config.base.mjs';

export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Machine-enforced vendor isolation: only auth/ may touch the provider.
    // Everything else consumes the neutral surface (auth/service.ts).
    files: ['**/*.ts'],
    ignores: ['auth/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/auth/provider', '*/auth/provider'],
              message: 'Import the neutral auth surface (auth/service.ts) instead of the vendor provider.',
            },
            {
              group: ['better-auth', 'better-auth/*'],
              message: 'The auth vendor is only importable inside auth/. Use the neutral surface (auth/service.ts).',
            },
          ],
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
];
