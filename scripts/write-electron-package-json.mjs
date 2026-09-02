/**
 * Marks `out/` as CommonJS.
 *
 * The root `package.json` declares `"type": "module"`, which Node applies to
 * every `.js` file unless a closer `package.json` overrides it. `main` and
 * `preload` are compiled to CommonJS deliberately — see the note in
 * `tsconfig.electron.json` — so `out/` needs its own override, or Node would
 * load the compiled output as ES modules and every `require` in it would
 * throw. This file is regenerated on every build; it is not committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('out', { recursive: true });
writeFileSync('out/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
