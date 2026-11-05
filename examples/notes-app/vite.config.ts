import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The SDK is consumed from source so the demo needs no separate build step.
const sdk = (p: string) => fileURLToPath(new URL(`../../packages/sdk/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [
    { find: '@entoli/sdk/react', replacement: sdk('react.ts') },
    { find: '@entoli/sdk', replacement: sdk('index.ts') },
  ] },
  test: { environment: 'jsdom' },
});
