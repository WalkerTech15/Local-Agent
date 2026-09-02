import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. The end-to-end Electron smoke suite under `tests/e2e/`
 * has its own config (`vitest.e2e.config.ts`) and its own script
 * (`npm run test:e2e`) because it needs a prior build and a real, much
 * longer-running Electron process — neither of which `npm test` should
 * silently require.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
  },
});
