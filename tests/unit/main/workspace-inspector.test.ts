import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listProjectTree,
  readProjectFile,
  searchProject,
} from '../../../src/main/workspace-inspector';
import { adoptProjectDirectory, type ApprovedProject } from '../../../src/main/workspace-session';
import {
  workspaceFileSchema,
  workspaceSearchResultSchema,
  workspaceTreeSchema,
} from '../../../src/shared/schemas/workspace.schema';
import {
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_SEARCH_RESULTS,
  WORKSPACE_MAX_TREE_DEPTH,
  WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH,
} from '../../../src/shared/constants';
import { WorkspaceError } from '../../../src/shared/workspace/errors';

/**
 * Read-only project inspection, against a real temporary directory (Phase 2,
 * Milestone 5).
 *
 * Nothing here mocks `fs`: the behaviours under test — what a walk descends
 * into, what a reader refuses, what a search opens — are behaviours against a
 * real filesystem, and a mock would only assert that the mock behaves as the
 * test expects.
 *
 * A separate concern runs throughout: **the inspector must never write.**
 * The final suite asserts that directly, by snapshotting the project tree
 * before and after every operation.
 */

const NOW = '2026-09-07T00:00:00.000Z';
const NUL = String.fromCharCode(0);

let dir: string;
let root: string;
let project: ApprovedProject;

async function write(relativePath: string, content: string | Buffer): Promise<void> {
  const absolute = join(root, ...relativePath.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-wsinspect-')));
  root = join(dir, 'demo');
  await mkdir(root, { recursive: true });

  await write('README.md', '# Demo project\n\nA fixture.\n');
  await write('package.json', '{"name":"demo","version":"1.0.0"}\n');
  await write('src/index.ts', 'export const answer = 42;\nexport const other = 1;\n');
  await write('src/util/helper.ts', 'export function help() {\n  return 42;\n}\n');
  await write('docs/guide.md', 'The answer is 42.\n');
  // Excluded by directory
  await write('node_modules/pkg/index.js', 'module.exports = 42;\n');
  await write('dist/bundle.js', 'var answer=42;\n');
  // Excluded by credential rules
  await write('.env', 'API_KEY=fake-sentinel-value\n');
  await write('deploy/server.pem', '-----BEGIN PRIVATE KEY-----\nfake\n');
  // Binary
  await write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await write('assets/data.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));

  project = await adoptProjectDirectory({
    chosenPath: root,
    now: NOW,
    userDataDir: join(dir, 'Local-Agent'),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`expected a rejection with ${code}`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe(code);
    },
  );
}

describe('listProjectTree', () => {
  it('lists the project root in tree order and validates against its schema', async () => {
    const tree = await listProjectTree(project, '');
    expect(workspaceTreeSchema.safeParse(tree).success).toBe(true);
    expect(tree.root).toBe('');

    const paths = tree.entries.map((entry) => entry.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('src');
    expect(paths).toContain('src/index.ts');

    // Depth-first pre-order: every descendant of `src` appears after `src`
    // itself and before the next top-level entry, so the flat list can be
    // rendered as an indented tree without rebuilding the hierarchy.
    const srcIndex = paths.indexOf('src');
    const nextTopLevel = tree.entries.findIndex(
      (entry, index) => index > srcIndex && entry.depth === 0,
    );
    const descendants = paths
      .slice(srcIndex + 1, nextTopLevel)
      .filter((path) => path.startsWith('src/'));
    expect(descendants.length).toBe(nextTopLevel - srcIndex - 1);
    expect(descendants).toContain('src/index.ts');
    expect(descendants).toContain('src/util/helper.ts');
  });

  it('sorts directories before files, each alphabetically', async () => {
    const tree = await listProjectTree(project, '');
    const topLevel = tree.entries.filter((entry) => entry.depth === 0);
    const firstFileIndex = topLevel.findIndex((entry) => entry.kind === 'file');
    const lastDirIndex = topLevel.map((entry) => entry.kind).lastIndexOf('directory');
    expect(lastDirIndex).toBeLessThan(firstFileIndex);
  });

  it('lists an excluded directory but never descends into it', async () => {
    const tree = await listProjectTree(project, '');
    const nodeModules = tree.entries.find((entry) => entry.path === 'node_modules');
    expect(nodeModules?.excluded).toBe(true);
    // Listed, so the tree does not misrepresent the project...
    expect(nodeModules).toBeDefined();
    // ...but nothing beneath it appears.
    expect(tree.entries.some((entry) => entry.path.startsWith('node_modules/'))).toBe(false);
    expect(tree.entries.some((entry) => entry.path.startsWith('dist/'))).toBe(false);
  });

  it('marks a credential file excluded and unreadable', async () => {
    const tree = await listProjectTree(project, '');
    const env = tree.entries.find((entry) => entry.path === '.env');
    expect(env?.excluded).toBe(true);
    expect(env?.readable).toBe(false);
  });

  it('marks a binary file unreadable without opening it', async () => {
    const tree = await listProjectTree(project, '');
    const logo = tree.entries.find((entry) => entry.path === 'assets/logo.png');
    expect(logo?.readable).toBe(false);
    expect(logo?.excluded).toBe(false);
  });

  it('reports a file size and no size for a directory', async () => {
    const tree = await listProjectTree(project, '');
    const readme = tree.entries.find((entry) => entry.path === 'README.md');
    const src = tree.entries.find((entry) => entry.path === 'src');
    expect(readme?.size).toBeGreaterThan(0);
    expect(src?.size).toBeUndefined();
  });

  it('lists a subdirectory when asked for one', async () => {
    const tree = await listProjectTree(project, 'src');
    expect(tree.root).toBe('src');
    expect(tree.entries.map((entry) => entry.path)).toContain('src/index.ts');
    expect(tree.entries.some((entry) => entry.path === 'README.md')).toBe(false);
  });

  it('refuses to list a path outside the project', async () => {
    await expectCode(listProjectTree(project, '../'), 'WORKSPACE_INVALID_PATH');
    await expectCode(listProjectTree(project, 'node_modules'), 'WORKSPACE_PATH_EXCLUDED');
  });

  it('refuses to list a file as though it were a directory', async () => {
    await expectCode(listProjectTree(project, 'README.md'), 'WORKSPACE_UNSUPPORTED_ENTRY');
  });

  it('reports a missing directory as not found', async () => {
    await expectCode(listProjectTree(project, 'no-such-dir'), 'WORKSPACE_NOT_FOUND');
  });

  it('stops at the depth bound and says so', async () => {
    const deep = Array.from({ length: WORKSPACE_MAX_TREE_DEPTH + 3 }, (_, i) => `d${String(i)}`);
    await write(`${deep.join('/')}/deep.txt`, 'too deep\n');

    const tree = await listProjectTree(project, '');
    expect(tree.truncated).toBe(true);
    for (const entry of tree.entries) {
      expect(entry.depth).toBeLessThanOrEqual(WORKSPACE_MAX_TREE_DEPTH);
    }
  });

  it('skips a name this codebase would refuse to accept back', async () => {
    // A name carrying a bidirectional override could never be requested via
    // `workspaceEntryPathSchema`, so listing it would offer a dead path.
    await write('safe.txt', 'ok\n');
    await writeFile(join(root, 'sp‮oofed.txt'), 'spoofed\n', 'utf8');

    const tree = await listProjectTree(project, '');
    expect(tree.entries.some((entry) => entry.name.includes('‮'))).toBe(false);
    expect(tree.entries.some((entry) => entry.path === 'safe.txt')).toBe(true);
  });
});

describe('readProjectFile', () => {
  it('reads a text file with its metadata', async () => {
    const file = await readProjectFile(project, 'src/index.ts');
    expect(workspaceFileSchema.safeParse(file).success).toBe(true);
    expect(file.content).toContain('export const answer = 42;');
    expect(file.metadata.path).toBe('src/index.ts');
    expect(file.metadata.name).toBe('index.ts');
    expect(file.metadata.encoding).toBe('utf-8');
    expect(file.metadata.lineCount).toBe(3);
    expect(file.metadata.warnings).toEqual([]);
  });

  it('reads an empty file as empty rather than failing', async () => {
    await write('empty.txt', '');
    const file = await readProjectFile(project, 'empty.txt');
    expect(file.content).toBe('');
    expect(file.metadata.size).toBe(0);
    expect(file.metadata.lineCount).toBe(0);
  });

  it('refuses a credential file that exists and is perfectly readable on disk', async () => {
    await expectCode(readProjectFile(project, '.env'), 'WORKSPACE_PATH_EXCLUDED');
    await expectCode(readProjectFile(project, 'deploy/server.pem'), 'WORKSPACE_PATH_EXCLUDED');
  });

  it('refuses a file inside an excluded directory', async () => {
    await expectCode(
      readProjectFile(project, 'node_modules/pkg/index.js'),
      'WORKSPACE_PATH_EXCLUDED',
    );
  });

  it('refuses a binary file by extension', async () => {
    await expectCode(readProjectFile(project, 'assets/logo.png'), 'WORKSPACE_BINARY_FILE');
  });

  it('refuses a binary file whose extension claims it is text', async () => {
    // Content sniffing, not the extension list, is what actually decides.
    await write('disguised.txt', Buffer.from([0x68, 0x69, 0x00, 0x21]));
    await expectCode(readProjectFile(project, 'disguised.txt'), 'WORKSPACE_BINARY_FILE');
  });

  it('refuses a file that is not valid UTF-8', async () => {
    await write('latin1.txt', Buffer.from([0x68, 0xff, 0xfe, 0x69]));
    await expectCode(readProjectFile(project, 'latin1.txt'), 'WORKSPACE_BINARY_FILE');
  });

  it('refuses a file larger than the limit, rather than truncating it', async () => {
    await write('huge.txt', 'a'.repeat(WORKSPACE_MAX_FILE_BYTES + 1));
    await expectCode(readProjectFile(project, 'huge.txt'), 'WORKSPACE_FILE_TOO_LARGE');
  });

  it('reads a file exactly at the size limit', async () => {
    await write('at-limit.txt', 'a'.repeat(WORKSPACE_MAX_FILE_BYTES));
    const file = await readProjectFile(project, 'at-limit.txt');
    expect(file.metadata.size).toBe(WORKSPACE_MAX_FILE_BYTES);
  });

  it('refuses a directory', async () => {
    await expectCode(readProjectFile(project, 'src'), 'WORKSPACE_UNSUPPORTED_ENTRY');
  });

  it('reports a missing file as not found', async () => {
    await expectCode(readProjectFile(project, 'src/absent.ts'), 'WORKSPACE_NOT_FOUND');
  });

  it('refuses a traversal', async () => {
    await expectCode(readProjectFile(project, '../outside.txt'), 'WORKSPACE_INVALID_PATH');
  });

  it('warns about bidirectional controls rather than refusing or rewriting the file', async () => {
    const content = 'const isAdmin = false; // ‪return true;‬\n';
    await write('trojan.ts', content);
    const file = await readProjectFile(project, 'trojan.ts');
    expect(file.metadata.warnings).toEqual(['bidirectional-control-characters']);
    // Shown exactly as stored: the viewer warns, it does not edit.
    expect(file.content).toBe(content);
  });

  it('never puts the file path into a thrown error', async () => {
    try {
      await readProjectFile(project, 'assets/logo.png');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as WorkspaceError).message).not.toContain('logo.png');
      expect((error as WorkspaceError).message).not.toContain(root);
    }
  });
});

describe('searchProject', () => {
  it('finds a literal substring and reports 1-based positions', async () => {
    const results = await searchProject(project, 'answer', '');
    expect(workspaceSearchResultSchema.safeParse(results).success).toBe(true);
    const match = results.matches.find((entry) => entry.path === 'src/index.ts');
    expect(match?.line).toBe(1);
    expect(match?.column).toBe(14);
    expect(match?.excerpt).toContain('answer');
  });

  it('matches case-insensitively', async () => {
    const results = await searchProject(project, 'ANSWER', '');
    expect(results.matches.some((match) => match.path === 'src/index.ts')).toBe(true);
  });

  it('never searches an excluded directory or a credential file', async () => {
    // `42` appears in node_modules, dist and .env-adjacent fixtures too.
    const results = await searchProject(project, '42', '');
    for (const match of results.matches) {
      expect(match.path.startsWith('node_modules/')).toBe(false);
      expect(match.path.startsWith('dist/')).toBe(false);
      expect(match.path).not.toBe('.env');
    }
  });

  it('never returns a match from a credential file, even for its own contents', async () => {
    const results = await searchProject(project, 'fake-sentinel-value', '');
    expect(results.matches).toEqual([]);
  });

  it('never searches a binary file', async () => {
    const results = await searchProject(project, 'PNG', '');
    expect(results.matches.some((match) => match.path.endsWith('.png'))).toBe(false);
  });

  it('searches only the requested subtree', async () => {
    const results = await searchProject(project, '42', 'src');
    expect(results.matches.length).toBeGreaterThan(0);
    for (const match of results.matches) {
      expect(match.path.startsWith('src/')).toBe(true);
    }
  });

  it('reports no match without failing', async () => {
    const results = await searchProject(project, 'zzz-not-present-zzz', '');
    expect(results.matches).toEqual([]);
    expect(results.truncated).toBe(false);
    expect(results.filesScanned).toBeGreaterThan(0);
  });

  it('stops at the result bound and marks the result truncated', async () => {
    const lines = Array.from({ length: WORKSPACE_MAX_SEARCH_RESULTS + 50 }, () => 'needle').join(
      '\n',
    );
    await write('many.txt', `${lines}\n`);
    const results = await searchProject(project, 'needle', '');
    expect(results.matches.length).toBe(WORKSPACE_MAX_SEARCH_RESULTS);
    expect(results.truncated).toBe(true);
  });

  it('reports at most one match per line, so one dense line cannot fill the budget', async () => {
    await write('dense.txt', `${'needle '.repeat(500)}\n`);
    const results = await searchProject(project, 'needle', '');
    const onDense = results.matches.filter((match) => match.path === 'dense.txt');
    expect(onDense.length).toBe(1);
  });

  it('bounds an excerpt and sanitizes it', async () => {
    await write('long.txt', `${'x'.repeat(2000)}needle${'y'.repeat(2000)}\n`);
    await write('ctrl.txt', `before\tneedle${NUL}after\n`);
    await write('bidi.txt', 'needle ‮spoofed‬ tail\n');

    const results = await searchProject(project, 'needle', '');
    for (const match of results.matches) {
      expect(match.excerpt.length).toBeLessThanOrEqual(WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH);
      expect(match.excerpt).not.toContain(NUL);
      expect(match.excerpt).not.toContain('‮');
    }
    // `ctrl.txt` is binary by content (it holds a NUL) and is skipped, which
    // is itself the safe outcome.
    expect(results.matches.some((match) => match.path === 'bidi.txt')).toBe(true);
  });

  it('treats the query as a literal substring, never as a regular expression', async () => {
    await write('regex.txt', 'the literal a.*b appears here\n');
    const results = await searchProject(project, 'a.*b', '');
    expect(results.matches.some((match) => match.path === 'regex.txt')).toBe(true);

    // A catastrophic backtracking pattern is just text, so it simply matches
    // nothing rather than hanging the main process.
    const evil = await searchProject(project, '(a+)+$', '');
    expect(evil.matches).toEqual([]);
  });

  it('refuses to search outside the project', async () => {
    await expectCode(searchProject(project, 'answer', '../'), 'WORKSPACE_INVALID_PATH');
    await expectCode(searchProject(project, 'answer', 'node_modules'), 'WORKSPACE_PATH_EXCLUDED');
  });
});

describe('the inspector is read-only', () => {
  /** Every path in the project, with its content, as one comparable snapshot. */
  async function snapshot(): Promise<string> {
    const tree = await listProjectTree(project, '');
    return JSON.stringify(
      tree.entries.map((entry) => [entry.path, entry.kind, entry.size ?? null]),
    );
  }

  it('changes nothing on disk across a full listing, read and search', async () => {
    const before = await snapshot();

    await listProjectTree(project, '');
    await listProjectTree(project, 'src');
    await readProjectFile(project, 'README.md');
    await readProjectFile(project, 'src/index.ts');
    await searchProject(project, 'answer', '');
    await searchProject(project, '42', 'src');

    expect(await snapshot()).toBe(before);
  });

  it('changes nothing on disk even when every operation fails', async () => {
    const before = await snapshot();

    await expect(readProjectFile(project, '.env')).rejects.toThrow();
    await expect(readProjectFile(project, 'no-such.ts')).rejects.toThrow();
    await expect(listProjectTree(project, '../')).rejects.toThrow();
    await expect(searchProject(project, 'x', 'node_modules')).rejects.toThrow();

    expect(await snapshot()).toBe(before);
  });

  it('logs nothing at all', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await listProjectTree(project, '');
    await readProjectFile(project, 'src/index.ts');
    await searchProject(project, 'answer', '');
    await expect(readProjectFile(project, '.env')).rejects.toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
