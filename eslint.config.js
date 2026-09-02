import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

/**
 * Milestone 1 lint configuration.
 *
 * The `src/shared` boundary rule is intentionally established now, before any
 * privileged code exists: `src/shared` holds pure schemas and constants and
 * must never reach the operating system or the Electron runtime. Enforcing it
 * from the start means a boundary violation fails the build rather than
 * relying on review.
 */

/**
 * Every Node built-in, taken from the runtime rather than a hand-written list.
 *
 * A maintained subset always falls behind: `node:sqlite` and `node:sea` did
 * not exist when a list like that would first have been written. Reading
 * `builtinModules` means new built-ins are covered the day the runtime gains
 * them.
 */
const nodeBuiltinNames = [
  ...new Set(builtinModules.map((name) => name.replace(/^node:/, ''))),
].sort();

/**
 * Bare and `node:`-prefixed forms of every built-in, for exact matching.
 *
 * These go in `paths`, not `patterns`. Pattern matching is gitignore-style, so
 * a bare pattern matches any path segment: the pattern `constants` — a real,
 * deprecated Node built-in — also matches the local import `../constants`.
 * Several built-ins have names that generic (`url`, `path`, `events`,
 * `assert`, `domain`, `punycode`), so exact matching is the only form that
 * cannot produce false positives on local files.
 */
const nodeBuiltinExactPaths = nodeBuiltinNames.flatMap((name) => [name, `node:${name}`]);

/** Modules `src/shared` is permitted to import by bare specifier. */
const SHARED_ALLOWED_BARE_IMPORTS = ['zod'];

/**
 * esquery predicate matching a module specifier that is neither relative nor
 * explicitly allowed.
 *
 * A relative specifier always starts with `.`; a bare one never does. Matching
 * on the leading character keeps a `/` out of the esquery regex, which its
 * parser does not accept.
 */
const DISALLOWED_BARE_SPECIFIER = `:not([source.value=/^[.]/]):not([source.value=/^(${SHARED_ALLOWED_BARE_IMPORTS.join('|')})$/])`;

const BARE_SPECIFIER_MESSAGE = `src/shared may import and re-export relative modules and ${SHARED_ALLOWED_BARE_IMPORTS.join(', ')} only.`;

const SHARED_PURITY_MESSAGE =
  'src/shared must stay pure: no I/O, no OS access, no runtime privileges. Move this into src/main.';
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'out/**', 'coverage/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          // Permits the `const { omitted, ...rest } = value` idiom used to
          // build objects with a field deliberately missing.
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  {
    // `src/shared` is consumed by every process, including the sandboxed
    // renderer. It must stay pure data: no OS access, no Electron, no network,
    // no runtime code execution.
    //
    // Imports are only half of the boundary. Node exposes `process`, `Buffer`
    // and `fetch` as globals, and `eval`/`new Function` execute code with no
    // import at all, so those are closed separately below.
    files: ['src/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          // Exact matches — see the note on nodeBuiltinExactPaths for why
          // these are not patterns.
          paths: [
            ...nodeBuiltinExactPaths.map((name) => ({
              name,
              message: SHARED_PURITY_MESSAGE,
            })),
            { name: 'electron', message: 'src/shared must not import Electron.' },
          ],
          patterns: [
            {
              // Safe as a pattern: no relative specifier begins with `node:`.
              group: ['node:*', 'electron/*'],
              message: SHARED_PURITY_MESSAGE,
            },
            {
              group: ['**/main/**', '**/renderer/**', '**/preload/**'],
              message:
                'src/shared must not depend on a specific process layer. Dependencies point inward only.',
            },
          ],
        },
      ],

      // Runtime privileges reachable without an import.
      //
      // `globalThis` itself is deliberately NOT blocked — it has safe uses and
      // blocking it outright makes the configuration brittle. Only the
      // privileged properties hanging off it are closed, below.
      'no-restricted-globals': [
        'error',
        { name: 'process', message: SHARED_PURITY_MESSAGE },
        { name: 'Buffer', message: SHARED_PURITY_MESSAGE },
        { name: '__dirname', message: SHARED_PURITY_MESSAGE },
        { name: '__filename', message: SHARED_PURITY_MESSAGE },
        { name: 'require', message: SHARED_PURITY_MESSAGE },
        { name: 'module', message: SHARED_PURITY_MESSAGE },
        { name: 'exports', message: SHARED_PURITY_MESSAGE },
        { name: 'global', message: SHARED_PURITY_MESSAGE },
        { name: 'fetch', message: 'src/shared must not perform network access.' },
        { name: 'XMLHttpRequest', message: 'src/shared must not perform network access.' },
        { name: 'WebSocket', message: 'src/shared must not perform network access.' },
        { name: 'EventSource', message: 'src/shared must not perform network access.' },
        { name: 'navigator', message: SHARED_PURITY_MESSAGE },
        { name: 'importScripts', message: SHARED_PURITY_MESSAGE },
      ],

      // Closes the `globalThis.process.env` style bypass of the rule above
      // without banning `globalThis` wholesale.
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'process', message: SHARED_PURITY_MESSAGE },
        { object: 'globalThis', property: 'Buffer', message: SHARED_PURITY_MESSAGE },
        { object: 'globalThis', property: 'require', message: SHARED_PURITY_MESSAGE },
        {
          object: 'globalThis',
          property: 'fetch',
          message: 'src/shared must not perform network access.',
        },
      ],

      // Code execution. `@typescript-eslint/no-implied-eval` is already on via
      // strictTypeChecked and covers the string-callback forms.
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'src/shared must not load modules at runtime.',
        },
        {
          // Default-deny on bare specifiers.
          //
          // The built-in denylist above enumerates what is forbidden, which
          // means it can only ever be as complete as the list. This inverts
          // it: anything that is not a relative path and not explicitly
          // allowed is rejected, so a built-in sub-path such as
          // `fs/promises`, a future built-in, or a newly added npm package is
          // blocked without anyone remembering to list it.
          selector: `ImportDeclaration${DISALLOWED_BARE_SPECIFIER}`,
          message: BARE_SPECIFIER_MESSAGE,
        },
        {
          // The same rule for a named re-export.
          //
          // `export { post } from 'axios'` pulls a package into the module
          // graph exactly as an import does, and runs its top-level side
          // effects in every process that loads the shared barrel. Covering
          // only `ImportDeclaration` would leave that route open.
          //
          // The `[source]` guard matters: a plain `export const x = 1` is also
          // an ExportNamedDeclaration, but its `source` is null, so without
          // the guard the two `:not(...)` clauses would both hold and every
          // ordinary export in the layer would be reported.
          selector: `ExportNamedDeclaration[source]${DISALLOWED_BARE_SPECIFIER}`,
          message: BARE_SPECIFIER_MESSAGE,
        },
        {
          // And for `export * from '...'`, which always carries a source.
          selector: `ExportAllDeclaration${DISALLOWED_BARE_SPECIFIER}`,
          message: BARE_SPECIFIER_MESSAGE,
        },
      ],
    },
  },

  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettierConfig,
);
