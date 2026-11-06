import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@prompt-aegis/core': r('./packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environmentMatchGlobs: undefined,
    coverage: { provider: 'v8', include: ['packages/*/src/**'] },
  },
});
