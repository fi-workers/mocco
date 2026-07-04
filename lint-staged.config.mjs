// lint + ts-check changed packages + prettier format
export default {
  'src/common/**/*.ts': () => 'yarn lint-common',
  'src/backend/**/*.ts': () => 'yarn lint-backend',
  'src/frontend/**/*.{ts,tsx}': () => 'yarn lint-frontend',
  '*.{ts,tsx,mjs,cjs,json,md,yml,yaml}': 'prettier --write',
};
