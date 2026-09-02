import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Bundles the preload script into one self-contained CommonJS file.
 *
 * With `sandbox: true`, Electron's preload scripts run inside a restricted
 * loader that only resolves `electron` and a short built-in allowlist —
 * `require('../shared/schemas')` fails there with "module not found" even
 * though the exact same code runs fine in the unsandboxed main process.
 * `zod` and everything under `src/shared` that the preload touches must
 * therefore be inlined into a single file rather than left as separate
 * `require()`s resolved at runtime. `electron` itself stays external: it is
 * always available in the preload context and must never be bundled.
 */
export default defineConfig({
  build: {
    outDir: 'out/preload',
    emptyOutDir: false,
    minify: false,
    target: 'node20',
    lib: {
      entry: resolve(dirname, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
