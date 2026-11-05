import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: [{ find: '@entoli/sdk/skill', replacement: fileURLToPath(new URL('../sdk/src/skill.ts', import.meta.url)) }] },
  test: { environment: 'node', testTimeout: 60000 },
});
