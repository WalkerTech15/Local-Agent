import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-scan regression test (Phase 2, Milestones 2-5).
 *
 * `src/shared/chat` and `src/shared/workspace` are structurally barred from
 * reaching Electron, Node built-ins, the network, or `window.localAgent` —
 * `eslint.config.js`'s purity boundary covers `src/shared/**`. Their renderer
 * counterparts, `src/renderer/chat` and `src/renderer/workspace`, are barred
 * from all of the same things **except** `window.localAgent`, which exactly
 * one file per feature is deliberately permitted to call:
 * `ipc-chat-provider.ts` for the real provider (Milestone 3) and
 * `ipc-workspace-client.ts` for the read-only workspace (Milestone 5). One
 * named seam each, and nothing else. This test makes both guarantees
 * empirical rather than relying solely on lint staying configured correctly
 * forever: it reads the actual source of every file in all four directories,
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
const SHARED_WORKSPACE_DIR = join(REPO_ROOT, 'src', 'shared', 'workspace');
const RENDERER_WORKSPACE_DIR = join(REPO_ROOT, 'src', 'renderer', 'workspace');
const SCAN_DIRECTORIES = [
  SHARED_CHAT_DIR,
  RENDERER_CHAT_DIR,
  SHARED_WORKSPACE_DIR,
  RENDERER_WORKSPACE_DIR,
];

/** The directories whose files may never reference `window.localAgent` at all. */
const SHARED_SCAN_DIRECTORIES = [SHARED_CHAT_DIR, SHARED_WORKSPACE_DIR];

/**
 * The only two files in the renderer permitted to reference
 * `window.localAgent` — one per feature, each the single seam through which
 * its privileged main-process counterpart is reached.
 */
const IPC_CHAT_PROVIDER_FILE = join(RENDERER_CHAT_DIR, 'ipc-chat-provider.ts');
const IPC_WORKSPACE_CLIENT_FILE = join(RENDERER_WORKSPACE_DIR, 'ipc-workspace-client.ts');
const BRIDGE_CALLER_FILES = [IPC_CHAT_PROVIDER_FILE, IPC_WORKSPACE_CLIENT_FILE].sort();

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
  {
    // A proposal is built in `main/ipc.ts` and nowhere else. Neither feature's
    // shared or renderer code may construct one, because building a proposal
    // is the step that asks for authority.
    label: 'ActionProposal (only main/ipc.ts may build one)',
    pattern: /ActionProposal/,
  },
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

  it('no code under src/shared references window.localAgent', () => {
    const offenders = [...codeByFile.entries()]
      .filter(([file]) => SHARED_SCAN_DIRECTORIES.some((dir) => file.startsWith(dir)))
      .filter(([, code]) => code.includes(WINDOW_LOCAL_AGENT_SUBSTRING))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('window.localAgent is referenced by exactly, and only, the two named bridge callers', () => {
    // One seam per feature, each named here. A future file that starts
    // calling the bridge fails this test immediately, independent of review.
    const offenders = [...codeByFile.entries()]
      .filter(([, code]) => code.includes(WINDOW_LOCAL_AGENT_SUBSTRING))
      .map(([file]) => file)
      .sort();
    expect(offenders).toEqual(BRIDGE_CALLER_FILES);
  });

  it('scans both features, so neither directory can be silently dropped', () => {
    for (const directory of SCAN_DIRECTORIES) {
      expect(
        files.some((file) => file.startsWith(directory)),
        `${directory} contributed no files to the scan`,
      ).toBe(true);
    }
  });
});
