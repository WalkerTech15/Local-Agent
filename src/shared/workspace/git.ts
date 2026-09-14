/**
 * The Git operation registry and porcelain parser (Phase 2, Milestone 6).
 *
 * Every `git` invocation this application can make is built here, from
 * literals. There are four, and the list is closed:
 *
 *  | Operation      | Argument vector                                        |
 *  | -------------- | ------------------------------------------------------ |
 *  | is-repository  | `rev-parse --is-inside-work-tree`                      |
 *  | branch         | `rev-parse --abbrev-ref HEAD`                          |
 *  | status         | `status --porcelain=v1 --branch --untracked-files=all` |
 *  | diff           | `diff --no-color --no-ext-diff --no-textconv -- <path>`|
 *  | stage          | `add --all --`                                         |
 *  | commit         | `commit --message <generated> --no-verify`             |
 *
 * ## What is absent, and why the absence is the control
 *
 * There is no `reset`, no `checkout`, no `switch`, no `restore`, no `clean`,
 * no `rm`, no `branch -d`, no `push`, no `fetch`, no `pull`, no `remote`, no
 * `rebase`, no `merge`, no `stash`, no `filter-branch`, no `reflog` and no
 * `config`. None of them can be reached, because there is no code path that
 * builds an argument vector from anything but the functions in this file, and
 * no request schema anywhere carries a git subcommand. A renderer cannot ask
 * for one; a model cannot propose one; a project cannot supply one.
 * {@link FORBIDDEN_GIT_SUBCOMMANDS} states the list so a test can assert it
 * stays absent from the runner's source.
 *
 * ## Two deliberate hardening choices
 *
 *  - **Hooks are disabled for every invocation.** A repository carries its own
 *    executable hooks in `.git/hooks`, and a checkpoint commit would otherwise
 *    run them. Executing code out of a directory the user merely *opened* is
 *    precisely the thing `AGENTS.md` §5 calls untrusted input, so
 *    {@link buildGitArgv} points `core.hooksPath` at an empty directory this
 *    application owns. `--no-verify` alone would not do it: it suppresses some
 *    hooks, not all of them.
 *  - **`--` terminates options everywhere a path appears.** A file called
 *    `--upload-pack=…` inside a project would otherwise be read by git as an
 *    option rather than a path.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { GIT_MAX_STATUS_ENTRIES } from '../constants';
import { isSafeWorkspaceRelativePath } from './path-safety';

/**
 * Subcommands this application must never run.
 *
 * Recorded as data so `tests/unit/main/git-runner.test.ts` can assert none of
 * them appears as a string literal in the runner, rather than the guarantee
 * resting on someone reading the file. Every entry either destroys work,
 * rewrites history, moves the checkout out from under the user, or talks to a
 * remote.
 */
export const FORBIDDEN_GIT_SUBCOMMANDS: readonly string[] = [
  'reset',
  'checkout',
  'switch',
  'restore',
  'clean',
  'rm',
  'mv',
  'branch',
  'push',
  'fetch',
  'pull',
  'clone',
  'remote',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'stash',
  'filter-branch',
  'gc',
  'prune',
  'reflog',
  'update-ref',
  'symbolic-ref',
  'worktree',
  'submodule',
  'config',
  'credential',
  'tag',
  'apply',
  'am',
  'archive',
  'bisect',
  'daemon',
  'init',
] as const;

/**
 * Wraps one operation's arguments in the fixed safety configuration.
 *
 * `hooksPath` must be a directory this application owns and keeps empty; it is
 * the only caller-supplied value, and it never comes from a project, a
 * renderer or a model.
 */
export function buildGitArgv(hooksPath: string, operationArgs: readonly string[]): string[] {
  return [
    // No pager: a pager would wait for a terminal that does not exist and the
    // command would simply hang until its timeout.
    '--no-pager',
    // Nothing in this application needs an interactive prompt, and a `git`
    // that decides to ask for one has nowhere to ask.
    '-c',
    'core.askpass=',
    '-c',
    'credential.helper=',
    // The project's own hooks are untrusted executables. See the header.
    '-c',
    `core.hooksPath=${hooksPath}`,
    // Avoid starting a background filesystem monitor for a directory the user
    // may only be inspecting once.
    '-c',
    'core.fsmonitor=false',
    ...operationArgs,
  ];
}

export function gitIsRepositoryArgs(): string[] {
  return ['rev-parse', '--is-inside-work-tree'];
}

/**
 * The absolute path of the working tree's root.
 *
 * Used for a containment check that has nothing to do with paths inside the
 * project and everything to do with the project's own position: if the user
 * approved a *subdirectory* of a repository, then `git add --all` run from
 * there would still stage the whole repository, including files outside the
 * directory they approved. Comparing this against the approved root is what
 * refuses that case.
 */
export function gitToplevelArgs(): string[] {
  return ['rev-parse', '--show-toplevel'];
}

export function gitBranchArgs(): string[] {
  return ['rev-parse', '--abbrev-ref', 'HEAD'];
}

/** The short hash of the current commit, so a checkpoint can be found again. */
export function gitHeadArgs(): string[] {
  return ['rev-parse', '--short', 'HEAD'];
}

export function gitStatusArgs(): string[] {
  return ['status', '--porcelain=v1', '--branch', '--untracked-files=all'];
}

/**
 * `git diff` for the working tree, optionally narrowed to one path.
 *
 * `--no-ext-diff` and `--no-textconv` matter for the same reason hooks are
 * disabled: both would otherwise let a repository's own configuration name a
 * program for git to run while producing the diff.
 */
export function gitDiffArgs(relativePath: string | null): string[] {
  const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3'];
  return relativePath === null ? [...base, '--'] : [...base, '--', relativePath];
}

export function gitStageAllArgs(): string[] {
  return ['add', '--all', '--'];
}

/**
 * The checkpoint commit.
 *
 * `message` is built by the main process from a fixed prefix and a timestamp;
 * no renderer, project or model text ever reaches it. `--no-verify` is
 * belt-and-braces alongside the `core.hooksPath` redirection in
 * {@link buildGitArgv}.
 */
export function gitCommitArgs(message: string): string[] {
  return ['commit', '--message', message, '--no-verify'];
}

// ---------------------------------------------------------------------------
// Porcelain parsing
// ---------------------------------------------------------------------------

export const GIT_STATUS_STATES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'ignored',
  'conflicted',
  'unknown',
] as const;

export type GitStatusState = (typeof GIT_STATUS_STATES)[number];

export interface GitStatusEntry {
  readonly path: string;
  /** The two porcelain status characters, index then working tree. */
  readonly code: string;
  readonly state: GitStatusState;
  readonly staged: boolean;
}

export interface GitStatusSummary {
  /** The branch name, or `null` when HEAD is detached or unknown. */
  readonly branch: string | null;
  readonly entries: readonly GitStatusEntry[];
  /** True when the entry bound stopped the listing early. */
  readonly truncated: boolean;
  /**
   * How many lines were dropped because their path could not be represented
   * safely — a quoted path containing a control character, for instance.
   * Reported rather than hidden: a status that silently omits a file is one a
   * reader would draw the wrong conclusion from.
   */
  readonly unparsableEntries: number;
}

function classify(code: string): GitStatusState {
  if (code === '??') return 'untracked';
  if (code === '!!') return 'ignored';
  const index = code[0] ?? ' ';
  const worktree = code[1] ?? ' ';
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) {
    return 'conflicted';
  }
  if (index === 'R' || worktree === 'R') return 'renamed';
  if (index === 'C' || worktree === 'C') return 'copied';
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'A') return 'added';
  if (index === 'M' || worktree === 'M' || worktree === 'A') return 'modified';
  return 'unknown';
}

/**
 * Parses `git status --porcelain=v1 --branch` output.
 *
 * Written defensively, because this is a program's output being read by the
 * process that owns every privileged operation in this application:
 *
 *  - a path git had to quote (because it contains a space it wants to escape,
 *    a control character, or a non-ASCII byte under the default
 *    `core.quotePath`) is **not** unquoted here; it is counted as unparsable
 *    and skipped, so no unescaping routine has to be trusted;
 *  - every surviving path must satisfy
 *    {@link isSafeWorkspaceRelativePath} — the same rule every other
 *    project-relative path in this codebase passes — so a status entry can
 *    never carry a path the rest of the application would refuse;
 *  - the entry list is bounded by {@link GIT_MAX_STATUS_ENTRIES}, and both
 *    kinds of omission are reported.
 */
export function parseGitStatus(stdout: string): GitStatusSummary {
  const entries: GitStatusEntry[] = [];
  let branch: string | null = null;
  let truncated = false;
  let unparsableEntries = 0;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;

    if (line.startsWith('## ')) {
      // `## main...origin/main [ahead 1]` — or `## HEAD (no branch)` when
      // detached, which yields no branch name at all.
      const descriptor = line.slice(3);
      const name = descriptor.split('...')[0]?.split(' ')[0] ?? '';
      branch = name.length > 0 && name !== 'HEAD' ? name : null;
      continue;
    }

    if (entries.length >= GIT_MAX_STATUS_ENTRIES) {
      truncated = true;
      break;
    }

    if (line.length < 4) {
      unparsableEntries += 1;
      continue;
    }

    const code = line.slice(0, 2);
    const remainder = line.slice(3);
    // A rename or copy reports `old -> new`; the destination is the path that
    // now exists, so that is the one reported.
    const arrow = remainder.lastIndexOf(' -> ');
    const candidate = arrow === -1 ? remainder : remainder.slice(arrow + 4);

    if (candidate.startsWith('"') || !isSafeWorkspaceRelativePath(candidate)) {
      unparsableEntries += 1;
      continue;
    }

    entries.push({
      path: candidate,
      code,
      state: classify(code),
      staged: code !== '??' && code !== '!!' && (code[0] ?? ' ') !== ' ',
    });
  }

  return { branch, entries, truncated, unparsableEntries };
}
