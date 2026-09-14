import { describe, expect, it } from 'vitest';

import {
  buildGitArgv,
  FORBIDDEN_GIT_SUBCOMMANDS,
  gitBranchArgs,
  gitCommitArgs,
  gitDiffArgs,
  gitHeadArgs,
  gitIsRepositoryArgs,
  gitStageAllArgs,
  gitStatusArgs,
  gitToplevelArgs,
  parseGitStatus,
} from '../../../src/shared/workspace/git';
import { GIT_MAX_STATUS_ENTRIES } from '../../../src/shared/constants';

/**
 * Git argument construction and porcelain parsing (Phase 2, Milestone 6).
 *
 * Two things are being asserted, and the second matters more than the first:
 * that the vectors this application builds are the ones intended, and that no
 * vector it can build is destructive. `git status` output is also a program's
 * output being parsed by the process that owns every privileged operation
 * here, so the parser is held to the same defensive standard as any other
 * untrusted input.
 */

const HOOKS = 'C:\\Users\\me\\AppData\\Roaming\\Local-Agent\\state\\git-hooks-disabled';

/** Every argument vector this module can produce, for exhaustive scanning. */
const EVERY_VECTOR: readonly string[][] = [
  gitIsRepositoryArgs(),
  gitToplevelArgs(),
  gitBranchArgs(),
  gitHeadArgs(),
  gitStatusArgs(),
  gitDiffArgs(null),
  gitDiffArgs('src/index.ts'),
  gitStageAllArgs(),
  gitCommitArgs('Local Agent checkpoint 2026-09-08T00:00:00.000Z'),
];

describe('buildGitArgv — the fixed safety configuration', () => {
  it('disables the repository’s own hooks on every invocation', () => {
    // A repository carries executable hooks. Running them because the user
    // opened a directory would be executing untrusted code.
    const argv = buildGitArgv(HOOKS, gitStatusArgs());
    expect(argv).toContain('-c');
    expect(argv).toContain(`core.hooksPath=${HOOKS}`);
  });

  it('disables the pager, credential helper and askpass', () => {
    const argv = buildGitArgv(HOOKS, gitStatusArgs()).join(' ');
    expect(argv).toContain('--no-pager');
    expect(argv).toContain('credential.helper=');
    expect(argv).toContain('core.askpass=');
  });

  it('puts the safety configuration before the operation, where git reads it', () => {
    const argv = buildGitArgv(HOOKS, gitStatusArgs());
    expect(argv.indexOf('status')).toBeGreaterThan(argv.lastIndexOf('-c'));
  });

  it('changes nothing about the operation it wraps', () => {
    const argv = buildGitArgv(HOOKS, gitDiffArgs('src/index.ts'));
    expect(argv.slice(-2)).toEqual(['--', 'src/index.ts']);
  });
});

describe('the closed set of operations', () => {
  it('never builds a destructive subcommand', () => {
    // The list is data so this scan cannot drift from the documentation.
    for (const vector of EVERY_VECTOR) {
      for (const forbidden of FORBIDDEN_GIT_SUBCOMMANDS) {
        expect(vector, `${forbidden} in ${vector.join(' ')}`).not.toContain(forbidden);
      }
    }
  });

  it('names a subcommand that reads, stages or commits, and nothing else', () => {
    const subcommands = EVERY_VECTOR.map((vector) => vector[0]);
    expect([...new Set(subcommands)].sort()).toEqual([
      'add',
      'commit',
      'diff',
      'rev-parse',
      'status',
    ]);
  });

  it('terminates options with `--` wherever a path can appear', () => {
    // A file called `--upload-pack=…` would otherwise be read as an option.
    expect(gitDiffArgs('src/index.ts')).toContain('--');
    expect(gitDiffArgs(null)).toContain('--');
    expect(gitStageAllArgs()).toContain('--');
  });

  it('puts the path after `--`, never before it', () => {
    const args = gitDiffArgs('src/index.ts');
    expect(args.indexOf('src/index.ts')).toBeGreaterThan(args.indexOf('--'));
  });

  it('never lets a repository name a program for git to run while diffing', () => {
    const args = gitDiffArgs(null);
    expect(args).toContain('--no-ext-diff');
    expect(args).toContain('--no-textconv');
  });

  it('commits with the message it was given and without running hooks', () => {
    const args = gitCommitArgs('Local Agent checkpoint 2026-09-08T00:00:00.000Z');
    expect(args).toEqual([
      'commit',
      '--message',
      'Local Agent checkpoint 2026-09-08T00:00:00.000Z',
      '--no-verify',
    ]);
  });

  it('stages only the working tree, never a remote or a ref', () => {
    expect(gitStageAllArgs()).toEqual(['add', '--all', '--']);
  });
});

describe('parseGitStatus', () => {
  it('reads the branch from the porcelain header', () => {
    expect(parseGitStatus('## main...origin/main [ahead 1]\n').branch).toBe('main');
    expect(parseGitStatus('## feature/thing\n').branch).toBe('feature/thing');
  });

  it('reports a detached HEAD as no branch at all', () => {
    expect(parseGitStatus('## HEAD (no branch)\n').branch).toBeNull();
  });

  it('classifies the ordinary states', () => {
    const status = parseGitStatus(
      ['## main', ' M src/a.ts', 'A  src/b.ts', ' D src/c.ts', '?? src/d.ts'].join('\n'),
    );
    expect(status.entries.map((entry) => `${entry.path}:${entry.state}`)).toEqual([
      'src/a.ts:modified',
      'src/b.ts:added',
      'src/c.ts:deleted',
      'src/d.ts:untracked',
    ]);
  });

  it('reports whether a change is staged', () => {
    const status = parseGitStatus(['## main', 'M  staged.ts', ' M unstaged.ts'].join('\n'));
    expect(status.entries[0]?.staged).toBe(true);
    expect(status.entries[1]?.staged).toBe(false);
  });

  it('takes the destination of a rename, which is the path that now exists', () => {
    const status = parseGitStatus(['## main', 'R  old.ts -> new.ts'].join('\n'));
    expect(status.entries[0]?.path).toBe('new.ts');
    expect(status.entries[0]?.state).toBe('renamed');
  });

  it('skips a quoted path rather than trusting an unescaping routine', () => {
    // git quotes a path containing a control character or a non-ASCII byte.
    // Rather than re-implement its escaping, such a line is counted and
    // dropped — reported, never silently omitted.
    const status = parseGitStatus(['## main', ' M "src/od\\303\\251.ts"', ' M ok.ts'].join('\n'));
    expect(status.entries.map((entry) => entry.path)).toEqual(['ok.ts']);
    expect(status.unparsableEntries).toBe(1);
  });

  it('refuses any path the rest of the codebase would refuse', () => {
    // A status entry must never carry a path other layers would reject, or
    // the interface would offer a path it could not act on.
    const status = parseGitStatus(
      ['## main', ' M ../outside.ts', ' M C:/absolute.ts', ' M src/ok.ts'].join('\n'),
    );
    expect(status.entries.map((entry) => entry.path)).toEqual(['src/ok.ts']);
    expect(status.unparsableEntries).toBe(2);
  });

  it('bounds the entry list and says that it did', () => {
    const many = ['## main'];
    for (let index = 0; index < GIT_MAX_STATUS_ENTRIES + 50; index += 1) {
      many.push(` M file${String(index)}.ts`);
    }
    const status = parseGitStatus(many.join('\n'));
    expect(status.entries.length).toBe(GIT_MAX_STATUS_ENTRIES);
    expect(status.truncated).toBe(true);
  });

  it('treats an empty status as a clean tree with no entries', () => {
    expect(parseGitStatus('## main\n').entries).toEqual([]);
    expect(parseGitStatus('').entries).toEqual([]);
  });

  it('tolerates carriage returns and never throws on malformed input', () => {
    for (const input of ['## main\r\n M a.ts\r\n', 'garbage', '#', '\n\n\n', ' ', '?']) {
      expect(() => parseGitStatus(input)).not.toThrow();
    }
  });
});
