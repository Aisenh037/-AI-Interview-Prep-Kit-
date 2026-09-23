import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@kit/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@kit/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: { provider: 'v8', reporter: ['text-summary'] },
  },
});
