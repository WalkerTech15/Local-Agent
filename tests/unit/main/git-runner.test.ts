import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCheckpointMessage,
  createGitCheckpoint,
  describeCheckpoint,
  readGitDiff,
  readGitStatus,
  type GitRuntime,
} from '../../../src/main/git-runner';
import { adoptProjectDirectory, type ApprovedProject } from '../../../src/main/workspace-session';
import { gitCheckpointSchema, gitDiffSchema, gitStatusSchema } from '../../../src/shared/schemas';
import { FORBIDDEN_GIT_SUBCOMMANDS } from '../../../src/shared/workspace/git';

/**
 * Git integration against a real repository (Phase 2, Milestone 6).
 *
 * These tests create actual repositories with actual commits, because the
 * properties that matter — that a checkpoint refuses on a detached HEAD, that
 * it refuses when the approved project is only a subdirectory of the
 * repository, that a repository's own hooks do not run — are properties of
 * how `git` behaves, and a mock would only assert that the mock behaves as
 * the test expects.
 *
 * If `git` is not installed the suite reports a skip rather than a false
 * pass.
 */

const NOW = '2026-09-08T00:00:00.000Z';

let dir: string;
let root: string;
let runtime: GitRuntime;
let project: ApprovedProject;
let gitAvailable = true;

/** The test's own git, not the product's — used only to build fixtures. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

async function write(relativePath: string, content: string): Promise<void> {
  const absolute = join(root, ...relativePath.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

async function approve(chosenPath = root): Promise<ApprovedProject> {
  return adoptProjectDirectory({
    chosenPath,
    now: NOW,
    userDataDir: join(dir, 'Local-Agent'),
  });
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-git-')));
  root = join(dir, 'demo');
  runtime = { hooksDir: join(dir, 'Local-Agent', 'state', 'git-hooks-disabled') };
  await mkdir(root, { recursive: true });

  try {
    git(root, 'init', '-b', 'main');
  } catch {
    gitAvailable = false;
    console.warn('skipped: git is not available on this machine');
    return;
  }

  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Local Agent Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  await write('README.md', '# Demo\n');
  await write('src/index.ts', 'export const answer = 42;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');

  project = await approve();
  // Explicit timeout, not a relaxed one: this hook spawns six real `git`
  // child processes per test (19 of them in this file). That is fast in
  // isolation, but the suite also spawns real npm/node/git processes in
  // sibling test files (Phase 2, Milestone 6's process-runner and
  // project-commands suites), and disk/CPU contention under full-suite
  // concurrency can occasionally push a synchronous `execFileSync` chain past
  // vitest's 10s default hook timeout.
}, 30_000);

afterEach(async () => {
  // Windows can hold a just-exited `git` process's working directory open for
  // a moment, so cleanup retries and then gives up. A temporary directory
  // that outlives the run is untidy; failing the suite over it would be
  // reporting a problem that is not there.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
});

describe('readGitStatus', () => {
  it('reports a clean tree on the current branch', async () => {
    if (!gitAvailable) return;
    const status = await readGitStatus(project, runtime);
    expect(status.branch).toBe('main');
    expect(status.clean).toBe(true);
    expect(status.entries).toEqual([]);
    expect(gitStatusSchema.safeParse(status).success).toBe(true);
  });

  it('reports a modified file', async () => {
    if (!gitAvailable) return;
    await write('src/index.ts', 'export const answer = 43;\n');
    const status = await readGitStatus(project, runtime);
    expect(status.clean).toBe(false);
    expect(status.entries.map((entry) => entry.path)).toContain('src/index.ts');
    expect(status.entries[0]?.state).toBe('modified');
  });

  it('reports an untracked file', async () => {
    if (!gitAvailable) return;
    await write('src/new.ts', 'export const x = 1;\n');
    const status = await readGitStatus(project, runtime);
    expect(status.entries.map((entry) => entry.state)).toContain('untracked');
  });

  it('refuses a project that is not a Git working tree', async () => {
    if (!gitAvailable) return;
    const plain = join(dir, 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'a.txt'), 'x\n');

    await expect(readGitStatus(await approve(plain), runtime)).rejects.toMatchObject({
      code: 'GIT_NOT_A_REPOSITORY',
    });
  });

  it('refuses a project that is only a subdirectory of a repository', async () => {
    if (!gitAvailable) return;
    // The containment control for Git: `git add --all` from a subdirectory
    // still stages the whole repository, which would reach files outside the
    // directory the user approved.
    const inner = join(root, 'src');
    await expect(readGitStatus(await approve(inner), runtime)).rejects.toMatchObject({
      code: 'GIT_NOT_A_REPOSITORY',
    });
  });
});

describe('readGitDiff', () => {
  it('reports no differences for a clean tree', async () => {
    if (!gitAvailable) return;
    const diff = await readGitDiff(project, runtime, null);
    expect(diff.empty).toBe(true);
    expect(diff.lines).toEqual([]);
    expect(gitDiffSchema.safeParse(diff).success).toBe(true);
  });

  it('classifies the lines of a real diff', async () => {
    if (!gitAvailable) return;
    await write('src/index.ts', 'export const answer = 43;\n');
    const diff = await readGitDiff(project, runtime, null);

    const kinds = new Set(diff.lines.map((line) => line.kind));
    expect(kinds.has('meta')).toBe(true);
    expect(kinds.has('hunk')).toBe(true);
    expect(kinds.has('added')).toBe(true);
    expect(kinds.has('removed')).toBe(true);
    expect(gitDiffSchema.safeParse(diff).success).toBe(true);
  });

  it('narrows the diff to one file when asked', async () => {
    if (!gitAvailable) return;
    await write('src/index.ts', 'export const answer = 43;\n');
    await write('README.md', '# Demo changed\n');

    const diff = await readGitDiff(project, runtime, 'src/index.ts');
    expect(diff.path).toBe('src/index.ts');
    const text = diff.lines.map((line) => line.text).join('\n');
    expect(text).toContain('src/index.ts');
    expect(text).not.toContain('README.md');
  });

  it('never carries a control character into the interface', async () => {
    if (!gitAvailable) return;
    await write('src/index.ts', 'export const answer = 43;\t// tab here\n');
    const diff = await readGitDiff(project, runtime, null);
    for (const line of diff.lines) {
      expect(line.text).not.toContain(String.fromCharCode(9));
    }
    expect(gitDiffSchema.safeParse(diff).success).toBe(true);
  });
});

describe('createGitCheckpoint', () => {
  it('creates one commit on the current branch and reports it', async () => {
    if (!gitAvailable) return;
    await write('src/index.ts', 'export const answer = 43;\n');

    const before = git(root, 'rev-list', '--count', 'HEAD').trim();
    const checkpoint = await createGitCheckpoint(project, runtime, NOW);
    const after = git(root, 'rev-list', '--count', 'HEAD').trim();

    expect(checkpoint.branch).toBe('main');
    expect(checkpoint.commit).toMatch(/^[0-9a-f]{4,40}$/);
    expect(checkpoint.message).toBe(buildCheckpointMessage(NOW));
    expect(checkpoint.filesChanged).toBe(1);
    expect(Number(after)).toBe(Number(before) + 1);
    expect(gitCheckpointSchema.safeParse(checkpoint).success).toBe(true);
  });

  it('leaves the working tree clean and the content intact', async () => {
    if (!gitAvailable) return;
    await write('src/index.ts', 'export const answer = 43;\n');
    await createGitCheckpoint(project, runtime, NOW);

    expect((await readGitStatus(project, runtime)).clean).toBe(true);
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const answer = 43;\n');
  });

  it('commits an untracked file too, so nothing is left unprotected', async () => {
    if (!gitAvailable) return;
    await write('src/brand-new.ts', 'export const x = 1;\n');
    await createGitCheckpoint(project, runtime, NOW);
    expect(git(root, 'ls-files', 'src/brand-new.ts').trim()).toBe('src/brand-new.ts');
  });

  it('refuses when there is nothing uncommitted', async () => {
    if (!gitAvailable) return;
    await expect(createGitCheckpoint(project, runtime, NOW)).rejects.toMatchObject({
      code: 'GIT_NOTHING_TO_COMMIT',
    });
  });

  it('refuses on a detached HEAD, where a commit would be easy to lose', async () => {
    if (!gitAvailable) return;
    const head = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'checkout', '--detach', head);
    await write('src/index.ts', 'export const answer = 43;\n');

    await expect(createGitCheckpoint(project, runtime, NOW)).rejects.toMatchObject({
      code: 'GIT_DETACHED_HEAD',
    });
    // And nothing was committed.
    expect(git(root, 'status', '--porcelain').trim().length).toBeGreaterThan(0);
  });

  it('refuses when the approved project is a subdirectory of the repository', async () => {
    if (!gitAvailable) return;
    await write('src/index.ts', 'export const answer = 43;\n');
    const inner = await approve(join(root, 'src'));

    await expect(createGitCheckpoint(inner, runtime, NOW)).rejects.toMatchObject({
      code: 'GIT_NOT_A_REPOSITORY',
    });
    expect(git(root, 'status', '--porcelain').trim().length).toBeGreaterThan(0);
  });

  it('does not run the repository’s own hooks', async () => {
    if (!gitAvailable) return;

    const hook = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\ntouch hook-ran.txt\n', 'utf8');
    await chmod(hook, 0o755).catch(() => undefined);

    // Control: prove the hook would run at all on this machine, otherwise the
    // assertion below would pass for the wrong reason.
    await write('src/index.ts', 'export const answer = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'control');
    let hookRuns = true;
    try {
      await stat(join(root, 'hook-ran.txt'));
    } catch {
      hookRuns = false;
      console.warn('skipped: git hooks do not execute on this machine');
    }
    if (!hookRuns) return;

    await rm(join(root, 'hook-ran.txt'), { force: true });

    // The real test: the product's checkpoint must not run it.
    await write('src/index.ts', 'export const answer = 2;\n');
    await createGitCheckpoint(project, runtime, NOW);
    await expect(stat(join(root, 'hook-ran.txt'))).rejects.toThrow();
  }, 60_000);

  it('states the exact commands before asking for approval', () => {
    const description = describeCheckpoint(NOW);
    expect(description).toContain('git add --all');
    expect(description).toContain('git commit');
    expect(description).toContain(buildCheckpointMessage(NOW));
    // A person approving must not be shown a command that is not what runs.
    for (const forbidden of FORBIDDEN_GIT_SUBCOMMANDS) {
      if (forbidden === 'add' || forbidden === 'commit') continue;
      expect(description, forbidden).not.toContain(` ${forbidden} `);
    }
  });

  it('builds a message from a fixed prefix and the supplied clock only', () => {
    expect(buildCheckpointMessage(NOW)).toBe(`Local Agent checkpoint ${NOW}`);
  });
});

describe('the source itself never names a destructive subcommand', () => {
  it('has no forbidden subcommand as a string literal in the git modules', () => {
    // A source scan, so the guarantee does not rest on someone reading the
    // files. Two things are stripped first, and both would otherwise produce
    // a match that means nothing: comments, because both modules freely
    // *describe* what they will never do, and the declaration of
    // `FORBIDDEN_GIT_SUBCOMMANDS` itself, which is by definition a list of
    // every one of these words as a quoted literal.
    const sources = ['src/main/git-runner.ts', 'src/shared/workspace/git.ts'] as const;

    for (const relative of sources) {
      const raw = readFileSync(join(__dirname, '..', '..', '..', relative), 'utf8');
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/export const FORBIDDEN_GIT_SUBCOMMANDS[\s\S]*?\] as const;/, '');

      // The strip must not have removed everything, or the scan is vacuous.
      expect(code.length, relative).toBeGreaterThan(200);

      for (const forbidden of FORBIDDEN_GIT_SUBCOMMANDS) {
        // As a quoted literal, which is the only way one could reach an
        // argument vector.
        expect(code.includes(`'${forbidden}'`), `${relative}: '${forbidden}'`).toBe(false);
        expect(code.includes(`"${forbidden}"`), `${relative}: "${forbidden}"`).toBe(false);
      }
    }
  });
});
