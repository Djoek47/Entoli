import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const sdk = (p: string) => fileURLToPath(new URL(`../../packages/sdk/src/${p}`, import.meta.url));
export default defineConfig({
  resolve: { alias: [
    { find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    { find: '@entoli/sdk/skill', replacement: sdk('skill.ts') },
    { find: /^@entoli\/sdk$/, replacement: sdk('index.ts') },
    { find: /^@entoli\/tester$/, replacement: fileURLToPath(new URL('../../packages/tester/src/index.ts', import.meta.url)) },
    { find: /^@entoli\/analyzer$/, replacement: fileURLToPath(new URL('../../packages/analyzer/src/index.ts', import.meta.url)) },
  ] },
  test: { environment: 'node', testTimeout: 20000 },
});
