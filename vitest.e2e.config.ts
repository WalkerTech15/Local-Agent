import { defineConfig } from 'vitest/config';

/**
 * Separate from `vitest.config.ts` on purpose.
 *
 * The default `npm test` suite is pure unit tests: no build step, no
 * external process, sub-second. This suite launches the real, built
 * Electron application, so it needs a prior `npm run build` and materially
 * longer timeouts. Keeping it out of the default `include` means `npm test`
 * never silently depends on a build being present. Run it via
 * `npm run test:e2e`, which builds first.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Electron launches one real OS process per test file; running files
    // concurrently multiplies flakiness for no speed benefit at this size.
    fileParallelism: false,
  },
});
