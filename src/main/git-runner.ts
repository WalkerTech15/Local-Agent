/**
 * Git integration (Phase 2, Milestone 6).
 *
 * Two read-only operations — `status` and `diff` — and exactly one that
 * changes anything: a checkpoint commit on the branch that is already checked
 * out. Every argument vector comes from `shared/workspace/git.ts`; this module
 * builds none of its own, and no request schema anywhere carries a git
 * subcommand, so the set of things git can be asked to do here is closed.
 *
 * ## What a checkpoint may not do
 *
 * `createGitCheckpoint` refuses rather than proceeds in every case where a
 * commit could cost the user something:
 *
 *  - **The project must be the repository root.** If the user approved a
 *    subdirectory of a repository, `git add --all` from there would still
 *    stage the whole repository — files outside the directory they approved.
 *    `--show-toplevel` is compared against the approved root, and a mismatch
 *    is refused. This is the same containment principle as
 *    `workspace-paths.ts`, applied to the one tool that has its own idea of
 *    where the project starts.
 *  - **HEAD must be on a branch.** A commit on a detached HEAD is trivially
 *    lost, and the checkpoint exists precisely so that nothing is lost.
 *  - **There must be something to commit.** An empty checkpoint is noise in
 *    someone's history.
 *
 * And what it never does, structurally: reset, checkout, switch, restore,
 * clean, remove, rebase, merge, stash, branch, tag, push, fetch, pull, or
 * touch a remote or a credential helper. See
 * {@link FORBIDDEN_GIT_SUBCOMMANDS}, which a test asserts is absent from this
 * file.
 *
 * ## Hooks are disabled for every invocation
 *
 * A repository carries executable hooks. Running them because the user opened
 * a directory would be executing code from untrusted input, so
 * `buildGitArgv` points `core.hooksPath` at an empty directory this
 * application owns and keeps empty. That directory is created here rather
 * than assumed to exist.
 */

import { mkdir, realpath } from 'node:fs/promises';

import { runProcess } from './process-runner';
import type { ProcessRunResult } from './process-runner';
import { isContainedPath } from './workspace-paths';
import type { ApprovedProject } from './workspace-session';
import {
  COMMAND_MAX_OUTPUT_LINES,
  GIT_CHECKPOINT_MESSAGE_PREFIX,
  GIT_MAX_DIFF_BYTES,
  GIT_TIMEOUT_MS,
  WORKSPACE_DIFF_MAX_LINES,
} from '../shared/constants';
import type { GitCheckpointValue, GitDiffValue, GitStatusValue } from '../shared/schemas';
import { gitDiffLineSchema } from '../shared/schemas/coding.schema';
import type { z } from 'zod';
import { WorkspaceError } from '../shared/workspace/errors';
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
} from '../shared/workspace/git';

/** Re-exported so a reviewer finds the list from either file. */
export { FORBIDDEN_GIT_SUBCOMMANDS };

type GitDiffLine = z.infer<typeof gitDiffLineSchema>;

export interface GitRuntime {
  /** An empty directory this application owns, used to disable repository hooks. */
  readonly hooksDir: string;
}

interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly result: ProcessRunResult;
}

function joinStream(result: ProcessRunResult, stream: 'stdout' | 'stderr'): string {
  return result.output
    .filter((line) => line.stream === stream)
    .map((line) => line.text)
    .join('\n');
}

/**
 * Runs one git invocation, or throws a normalized error.
 *
 * Git's own stderr never crosses a boundary — it routinely contains absolute
 * paths, branch names and occasionally a remote URL. A failure becomes
 * `GIT_COMMAND_FAILED` and nothing more, exactly as a filesystem `errno`
 * becomes `WORKSPACE_READ_FAILED` in `workspace-paths.ts`.
 */
async function runGit(
  project: ApprovedProject,
  runtime: GitRuntime,
  operationArgs: readonly string[],
  maxOutputBytes = GIT_MAX_DIFF_BYTES,
): Promise<GitOutcome> {
  await mkdir(runtime.hooksDir, { recursive: true }).catch(() => undefined);

  let result: ProcessRunResult;
  try {
    result = await runProcess({
      program: 'git',
      args: buildGitArgv(runtime.hooksDir, operationArgs),
      cwd: project.rootPath,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes,
      maxOutputLines: COMMAND_MAX_OUTPUT_LINES,
    });
  } catch {
    throw new WorkspaceError('GIT_UNAVAILABLE');
  }

  return { ok: result.exitCode === 0, stdout: joinStream(result, 'stdout'), result };
}

/**
 * Confirms the approved project is a Git working tree *and* is its root.
 *
 * Both halves matter: the first because git is otherwise being asked about a
 * directory it knows nothing about, the second because every write-adjacent
 * git operation in this module works on the whole working tree.
 */
async function requireRepositoryRoot(project: ApprovedProject, runtime: GitRuntime): Promise<void> {
  if (!project.hasGitMetadata) throw new WorkspaceError('GIT_NOT_A_REPOSITORY');

  const inside = await runGit(project, runtime, gitIsRepositoryArgs());
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    throw new WorkspaceError('GIT_NOT_A_REPOSITORY');
  }

  const toplevel = await runGit(project, runtime, gitToplevelArgs());
  if (!toplevel.ok) throw new WorkspaceError('GIT_NOT_A_REPOSITORY');

  const reported = toplevel.stdout.trim();
  if (reported.length === 0) throw new WorkspaceError('GIT_NOT_A_REPOSITORY');

  // Canonicalise both sides before comparing, for exactly the reason
  // `workspace-session.ts` canonicalises the user-data directory: a short
  // (8.3) Windows ancestor shares no common root with its long form, and a
  // comparison between the two forms would silently pass.
  let canonical: string;
  try {
    canonical = await realpath(reported);
  } catch {
    throw new WorkspaceError('GIT_NOT_A_REPOSITORY');
  }
  if (
    !isContainedPath(project.rootPath, canonical) ||
    !isContainedPath(canonical, project.rootPath)
  ) {
    throw new WorkspaceError('GIT_NOT_A_REPOSITORY');
  }
}

/** `git status`, parsed, bounded, and with every path re-validated. */
export async function readGitStatus(
  project: ApprovedProject,
  runtime: GitRuntime,
): Promise<GitStatusValue> {
  await requireRepositoryRoot(project, runtime);

  const status = await runGit(project, runtime, gitStatusArgs());
  if (!status.ok) throw new WorkspaceError('GIT_COMMAND_FAILED');

  const parsed = parseGitStatus(status.stdout);
  return {
    branch: parsed.branch,
    entries: [...parsed.entries],
    clean: parsed.entries.length === 0 && parsed.unparsableEntries === 0,
    truncated: parsed.truncated || status.result.outputTruncated,
    unparsableEntries: parsed.unparsableEntries,
  };
}

function classifyDiffLine(line: string): GitDiffLine['kind'] {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('Binary files')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

/**
 * `git diff` for the working tree, optionally narrowed to one file.
 *
 * `relativePath` has already been validated by the request schema and is
 * passed after `--`, so a file whose name begins with a dash cannot be read
 * by git as an option.
 *
 * Note that tab characters in the diff arrive as spaces: every line crossing
 * to the renderer is sanitized by the process runner, and a tab is a control
 * character. Indentation is therefore approximate in this view. It is a
 * display trade-off, taken deliberately rather than loosening the rule that
 * no control character reaches the interface.
 */
export async function readGitDiff(
  project: ApprovedProject,
  runtime: GitRuntime,
  relativePath: string | null,
): Promise<GitDiffValue> {
  await requireRepositoryRoot(project, runtime);

  const diff = await runGit(project, runtime, gitDiffArgs(relativePath));
  if (!diff.ok) throw new WorkspaceError('GIT_COMMAND_FAILED');

  const rawLines = diff.stdout.length === 0 ? [] : diff.stdout.split('\n');
  const lines: GitDiffLine[] = [];
  let truncated = diff.result.outputTruncated;

  for (const line of rawLines) {
    if (lines.length >= WORKSPACE_DIFF_MAX_LINES) {
      truncated = true;
      break;
    }
    lines.push({ kind: classifyDiffLine(line), text: line });
  }

  return { path: relativePath, lines, truncated, empty: lines.length === 0 };
}

/** The message a checkpoint commits under. Never renderer or project text. */
export function buildCheckpointMessage(now: string): string {
  return `${GIT_CHECKPOINT_MESSAGE_PREFIX} ${now}`;
}

/**
 * Describes exactly what a checkpoint would do, for the confirmation dialog.
 *
 * Built before the confirmation rather than after it, so the user approves a
 * statement of the real commands rather than a summary of them.
 */
export function describeCheckpoint(now: string): string {
  const message = buildCheckpointMessage(now);
  return `git add --all\ngit commit --message "${message}" --no-verify`;
}

/**
 * Stages everything in the working tree and creates one commit.
 *
 * Nothing here removes, resets or moves anything: `add` stages, `commit`
 * records. A user who did not want the checkpoint can undo it with their own
 * tools, and their content is in the commit either way — which is the whole
 * point of taking one before a change.
 */
export async function createGitCheckpoint(
  project: ApprovedProject,
  runtime: GitRuntime,
  now: string,
): Promise<GitCheckpointValue> {
  await requireRepositoryRoot(project, runtime);

  const branchOutcome = await runGit(project, runtime, gitBranchArgs());
  if (!branchOutcome.ok) throw new WorkspaceError('GIT_COMMAND_FAILED');
  const branch = branchOutcome.stdout.trim();
  if (branch.length === 0 || branch === 'HEAD') throw new WorkspaceError('GIT_DETACHED_HEAD');

  const statusOutcome = await runGit(project, runtime, gitStatusArgs());
  if (!statusOutcome.ok) throw new WorkspaceError('GIT_COMMAND_FAILED');
  const parsed = parseGitStatus(statusOutcome.stdout);
  const filesChanged = parsed.entries.length + parsed.unparsableEntries;
  if (filesChanged === 0) throw new WorkspaceError('GIT_NOTHING_TO_COMMIT');

  const staged = await runGit(project, runtime, gitStageAllArgs());
  if (!staged.ok) throw new WorkspaceError('GIT_COMMAND_FAILED');

  const message = buildCheckpointMessage(now);
  const committed = await runGit(project, runtime, gitCommitArgs(message));
  if (!committed.ok) throw new WorkspaceError('GIT_COMMAND_FAILED');

  const head = await runGit(project, runtime, gitHeadArgs());
  if (!head.ok) throw new WorkspaceError('GIT_COMMAND_FAILED');
  const commit = head.stdout.trim();
  if (!/^[0-9a-f]{4,40}$/.test(commit)) throw new WorkspaceError('GIT_COMMAND_FAILED');

  return { branch, commit, message, filesChanged, createdAt: now };
}
