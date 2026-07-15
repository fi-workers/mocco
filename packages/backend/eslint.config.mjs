import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig, houseStyle, restrictedSyntax } from '../../eslint.config.base.mjs';

// Shared no-restricted-imports patterns. `no-restricted-imports` arrays do NOT merge
// across flat-config objects (last matching object wins), so any block that sets the
// rule must re-declare every pattern it wants — hence these shared consts.
const relativeImportBan = {
  // Absolute imports only: every internal import uses the @backend/* alias,
  // never a relative ./ or ../. Cross-package stays @mocco/*.
  regex: '^\\.',
  message: 'Use the @backend/* absolute import, not a relative ./ or ../ path.',
};
const vendorImportPatterns = [
  {
    group: ['**/auth/provider', '*/auth/provider'],
    message:
      'Import the neutral auth surface (auth/AuthService.ts, auth/WorkspaceService.ts) instead of the vendor provider.',
  },
  {
    group: ['better-auth', 'better-auth/*'],
    message: 'The auth vendor is only importable inside auth/. Use the neutral surface (auth/*Service.ts).',
  },
];
// A service reaches the DB only through its repository (domain/<d>/repos/*.repo.ts).
const dbImportBan = [
  {
    group: ['drizzle-orm', 'drizzle-orm/*'],
    message: 'A service reaches the DB through its repo (domain/<d>/repos/*.repo.ts), never drizzle directly.',
  },
  {
    group: ['**/infra/db/schema', '@backend/infra/db/schema'],
    message: 'A service reaches the DB through its repo, not the schema directly.',
  },
];

export default [
  ...createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Machine-enforced vendor isolation: only auth/ may touch the provider.
    // Everything else consumes the neutral surface (auth/AuthService.ts, auth/WorkspaceService.ts).
    files: ['**/*.ts'],
    ignores: ['src/domain/auth/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...vendorImportPatterns, relativeImportBan] }],
    },
  },
  {
    // auth/ is excluded from the vendor block above (it IS the vendor boundary and
    // legitimately imports ./provider), but it still holds to the no-relative rule.
    files: ['src/domain/auth/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [relativeImportBan] }],
    },
  },
  {
    // A DB-owning domain's service reaches its tables only through a repository — never
    // drizzle/schema directly. auth is excluded (vendor-mediated, owns no tables here).
    // Re-includes the vendor + relative bans since arrays don't merge (last block wins).
    files: ['src/domain/**/*Service.ts'],
    ignores: ['src/domain/auth/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...vendorImportPatterns, relativeImportBan, ...dbImportBan] }],
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
