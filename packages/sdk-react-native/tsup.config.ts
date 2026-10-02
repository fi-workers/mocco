import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/mocco-react-native.ts', 'src/ota.ts', 'src/messenger.tsx'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  // Peers come from the app; @mocco/sdk-core is a dependency, not a copy.
  external: ['@mocco/sdk-core', 'expo-updates', 'react', 'react-native'],
});
