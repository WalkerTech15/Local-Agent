import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-scan regression test (Phase 2, Milestones 2-3).
 *
 * `src/shared/chat` is structurally barred from reaching Electron, Node
 * built-ins, the network, or `window.localAgent` — `eslint.config.js`'s
 * purity boundary covers `src/shared/**`. `src/renderer/chat` is barred from
 * all of the same things **except** `window.localAgent`, which exactly one
 * file — `ipc-chat-provider.ts` — is deliberately permitted to call, since
 * Milestone 3 needs one seam through which the real, network-capable
 * adapter in `src/main` is reached. This test makes both guarantees
 * empirical rather than relying solely on lint staying configured correctly
 * forever: it reads the actual source of every file in both directories,
 * strips comments (this codebase's own doc comments freely *describe* what
 * is absent or narrowly permitted — "never touches `window.localAgent`",
 * "the one file... permitted to reference `window.localAgent`" — which
 * would otherwise trip a naive substring scan on prose, not code), and
 * asserts every forbidden reference is absent, with `window.localAgent`
 * checked separately against its one named exception.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SHARED_CHAT_DIR = join(REPO_ROOT, 'src', 'shared', 'chat');
const RENDERER_CHAT_DIR = join(REPO_ROOT, 'src', 'renderer', 'chat');
const SCAN_DIRECTORIES = [SHARED_CHAT_DIR, RENDERER_CHAT_DIR];

/** The one file under `src/renderer/chat` permitted to reference `window.localAgent`. */
const IPC_CHAT_PROVIDER_FILE = join(RENDERER_CHAT_DIR, 'ipc-chat-provider.ts');

const WINDOW_LOCAL_AGENT_SUBSTRING = 'window.localAgent';

const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'ipcRenderer', pattern: /ipcRenderer/ },
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

  it('no code under src/shared/chat references window.localAgent', () => {
    const offenders = [...codeByFile.entries()]
      .filter(([file]) => file.startsWith(SHARED_CHAT_DIR))
      .filter(([, code]) => code.includes(WINDOW_LOCAL_AGENT_SUBSTRING))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('window.localAgent is referenced by exactly, and only, ipc-chat-provider.ts', () => {
    const offenders = [...codeByFile.entries()]
      .filter(([, code]) => code.includes(WINDOW_LOCAL_AGENT_SUBSTRING))
      .map(([file]) => file);
    expect(offenders).toEqual([IPC_CHAT_PROVIDER_FILE]);
  });
});
