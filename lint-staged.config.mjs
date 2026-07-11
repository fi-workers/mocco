// lint + ts-check changed packages + prettier format
export default {
  'packages/common/**/*.ts': () => 'yarn lint-common',
  'packages/backend/**/*.ts': () => 'yarn lint-backend',
  'packages/frontend/**/*.{ts,tsx}': () => 'yarn lint-frontend',
  'packages/e2e/**/*.ts': () => 'yarn lint-e2e',
  '*.{ts,tsx,mjs,cjs,json,md,yml,yaml}': 'prettier --write',
};
