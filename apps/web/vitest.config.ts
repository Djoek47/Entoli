import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const sdk = (p: string) => fileURLToPath(new URL(`../../packages/sdk/src/${p}`, import.meta.url));
export default defineConfig({
  resolve: { alias: [
    { find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    { find: '@entoli/sdk/skill', replacement: sdk('skill.ts') },
    { find: /^@entoli\/sdk$/, replacement: sdk('index.ts') },
  ] },
  test: { environment: 'node', testTimeout: 20000 },
});
