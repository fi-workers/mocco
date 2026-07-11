import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { configs as airbnb, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

/** @param {{ tsconfigRootDir: string }} o @returns {import('eslint').Linter.Config[]} */
export function createBaseConfig({ tsconfigRootDir }) {
  return [
    {
      ignores: [
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**',
        '**/*.gen.ts',
        '**/migrations/**',
        '**/eslint.config.mjs',
        'eslint.config.base.mjs',
        '**/*.config.{js,mjs,cjs}',
      ],
    },
    js.configs.recommended,

    // Register plugins referenced by airbnb (excluding typescriptEslint — registered by tseslint)
    airbnbPlugins.stylistic,
    airbnbPlugins.importX,

    // Strictest type-aware presets (includes @typescript-eslint registration)
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,

    // airbnb parity (rules)
    ...airbnb.base.recommended,
    ...airbnb.base.typescript,

    // Additional strict
    unicorn.configs.recommended,
    sonarjs.configs.recommended,

    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
        globals: { ...globals.node, ...globals.es2024 },
      },
    },
    {
      settings: {
        'import-x/resolver-next': [
          createTypeScriptImportResolver({ alwaysTryTypes: true, project: ['packages/*/tsconfig.json'] }),
        ],
      },
    },
    {
      files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
      rules: {
        'no-plusplus': 'off',
        'no-underscore-dangle': 'off',
        curly: ['error', 'all'],
        eqeqeq: ['error', 'always', { null: 'ignore' }],
        'prefer-const': 'error',
        'no-console': ['warn', { allow: ['warn', 'error'] }],
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            args: 'all',
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            ignoreRestSiblings: true,
          },
        ],
        'import-x/order': [
          'error',
          {
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],
        'import-x/prefer-default-export': 'off',
        'import-x/no-default-export': 'off',
        'import-x/extensions': 'off',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
        '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
        // Exceptions must be catchable where they're awaited, and async frames must
        // survive in stack traces — always `return await`, never bare `return promise`.
        // promise-function-async closes the loophole: a non-async function returning
        // a promise would silently escape the return-await rule.
        'no-return-await': 'off',
        '@typescript-eslint/return-await': ['error', 'always'],
        '@typescript-eslint/promise-function-async': 'error',
        'unicorn/prevent-abbreviations': 'off',
        'unicorn/no-null': 'off',
        'unicorn/filename-case': 'off',
        'unicorn/no-array-reduce': 'off',
        'unicorn/no-array-for-each': 'off',
        'unicorn/prefer-top-level-await': 'off',
        'unicorn/no-process-exit': 'off',
        'unicorn/prefer-ternary': 'off',
        'unicorn/switch-case-braces': 'off',
        'unicorn/no-useless-undefined': 'off',
        'unicorn/max-nested-calls': 'off',
        'unicorn/name-replacements': 'off',
        'sonarjs/argument-type': 'off',
        'sonarjs/no-duplicate-string': ['warn', { threshold: 5 }],
        'sonarjs/cognitive-complexity': ['warn', 15],
        'sonarjs/todo-tag': 'off',
      },
    },
    { files: ['**/*.{js,mjs,cjs}', '**/*.config.{js,mjs,cjs,ts}'], ...tseslint.configs.disableTypeChecked },

    // No index/barrel files (FSD-style re-export hubs): they hide the real module
    // graph and defeat direct imports. Name modules concretely; consumers import
    // the concrete path (cross-package via explicit package.json "exports" subpaths).
    {
      files: ['**/index.{ts,tsx,mts,cts}'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: 'Program',
            message: 'No index.ts files — name the module concretely and import it directly (no barrels).',
          },
        ],
      },
    },

    // Test files and test-support helpers may use devDependencies (test-only packages like pglite),
    // and fixture credentials are not real secrets.
    {
      files: ['**/*.{test,spec}.{ts,tsx,mts,cts}', '**/testing/**', '**/test/**'],
      rules: {
        'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }],
        'sonarjs/no-hardcoded-passwords': 'off',
        'sonarjs/no-duplicate-string': 'off',
      },
    },

    // No index/barrel files (FSD-style re-export hubs): they hide the real module
    // graph and defeat direct imports. Name modules concretely; consumers import
    // the concrete path (cross-package via explicit package.json "exports" subpaths).
    {
      files: ['**/index.{ts,tsx,mts,cts}'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: 'Program',
            message: 'No index.ts files — name the module concretely and import it directly (no barrels).',
          },
        ],
      },
    },
  ];
}
