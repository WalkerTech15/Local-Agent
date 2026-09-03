import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-scan regression test (Phase 2, Milestone 2).
 *
 * The chat and provider layers are already structurally barred from
 * reaching Electron, Node built-ins, the network, or `window.localAgent` —
 * `eslint.config.js`'s purity boundary covers `src/shared/**`, and nothing
 * under `src/renderer/chat` imports the preload bridge. This test makes that
 * guarantee empirical rather than relying solely on lint staying configured
 * correctly forever: it reads the actual source of every file in both
 * directories, strips comments (this codebase's own doc comments freely
 * *describe* what is absent — "never touches `window.localAgent`" — which
 * would otherwise trip a naive substring scan on prose, not code), and
 * asserts none of the forbidden references appear anywhere in what remains.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = [
  join(REPO_ROOT, 'src', 'shared', 'chat'),
  join(REPO_ROOT, 'src', 'renderer', 'chat'),
];

const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'ipcRenderer', pattern: /ipcRenderer/ },
  { label: 'window.localAgent', pattern: /window\.localAgent/ },
  { label: "import ... from 'electron'", pattern: /from ['"]electron['"]/ },
  { label: 'require("electron")', pattern: /require\(['"]electron['"]\)/ },
  { label: 'child_process', pattern: /child_process/ },
  { label: 'node:fs', pattern: /from ['"]node:fs/ },
  { label: 'fetch(', pattern: /\bfetch\(/ },
  { label: 'XMLHttpRequest', pattern: /XMLHttpRequest/ },
  { label: 'WebSocket', pattern: /\bWebSocket\b/ },
  { label: 'eval(', pattern: /\beval\(/ },
  { label: 'new Function(', pattern: /new Function\(/ },
  { label: 'dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/ },
  { label: 'ActionProposal (chat has no action to authorize)', pattern: /ActionProposal/ },
];

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Strips `/* ... *\/` block comments (including JSDoc) and `// ...` line
 * comments. Verified safe for this specific, small scan target: none of the
 * files under scan contain a `//` inside a string literal (checked by
 * inspection — every `//` occurrence in them is already inside a comment),
 * so this does not need a full tokenizer to be correct here.
 */
function stripComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.replace(/\/\/.*$/gm, '');
}

describe('chat/provider layer source-scan boundary', () => {
  const files = SCAN_DIRECTORIES.flatMap((dir) => listSourceFiles(dir));
  const codeByFile = new Map(
    files.map((file) => [file, stripComments(readFileSync(file, 'utf8'))]),
  );

  it('found a non-empty set of files to scan (the scan itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('comment-stripping does not silently empty out a whole file', () => {
    for (const [file, code] of codeByFile) {
      expect(code.trim().length, `${file} became empty after stripping comments`).toBeGreaterThan(
        0,
      );
    }
  });

  it.each(FORBIDDEN_PATTERNS)('no code (comments excluded) references $label', ({ pattern }) => {
    const offenders = [...codeByFile.entries()]
      .filter(([, code]) => pattern.test(code))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
