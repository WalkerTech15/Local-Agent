/**
 * Path containment for the read-only workspace (Phase 2, Milestone 5).
 *
 * This is the **second** of the two containment defences, and the one that
 * touches the disk. `src/shared/workspace/path-safety.ts` decides whether a
 * string is even shaped like a path inside a project; this module decides
 * where that string actually lands once it is joined onto a real root and the
 * filesystem has had its say.
 *
 * Both are required, and neither is a duplicate of the other:
 *
 *  - A lexical rule cannot see a symbolic link. `src/notes` may be a perfectly
 *    well-formed relative path and still be a link to `C:\Users\me\.ssh`.
 *  - A `realpath` check cannot run on a string that has not been joined onto a
 *    root yet — and joining is exactly the step an absolute path or a `..`
 *    segment subverts, so by the time `realpath` could look, the damage would
 *    already be in the path it was handed.
 *
 * So every resolution runs, in order: validate lexically, refuse excluded
 * segments, join, check containment on the joined path, canonicalise with
 * `realpath`, and check containment **again** on the canonical result. A link
 * pointing outside the project fails the last check even though it passed the
 * first.
 *
 * ## The one gap, stated plainly
 *
 * Between `realpath` returning and the subsequent `open`/`readdir`, a path
 * component could in principle be replaced with a link — the classic
 * time-of-check/time-of-use race. Closing it properly needs handle-based,
 * `O_NOFOLLOW`-style APIs that Node does not expose portably. The exposure
 * here is narrow (the attacker must already be able to write inside the
 * user's own approved project, on the user's own machine, between two
 * adjacent syscalls) and the consequence is bounded by everything else in
 * this layer: the result is still read-only, still size-capped, and still
 * refused if it is not text. It is recorded in `docs/security-model.md`
 * rather than described as solved.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

import { WorkspaceError } from '../shared/workspace/errors';
import { containsExcludedSegment } from '../shared/workspace/exclusions';
import { normalizeWorkspaceRelativePath } from '../shared/workspace/path-safety';

/**
 * True when `candidate` is `root` itself or lies beneath it.
 *
 * Uses `path.relative` rather than a string prefix comparison, which matters
 * on Windows for two reasons a prefix test gets wrong: `relative` compares
 * case-insensitively there (so `C:\Foo` contains `C:\foo\bar`), and it
 * normalises mixed separators. The explicit `'..'` checks are written against
 * a whole segment rather than as `startsWith('..')`, so a directory
 * legitimately named `..config` is not mistaken for an escape.
 */
export function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  if (relativePath === '') return true;
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) return false;
  // An absolute result means the two share no common root at all — different
  // drives on Windows, for instance.
  return !isAbsolute(relativePath);
}

/** One resolved, contained entry inside an approved project. */
export interface ResolvedProjectPath {
  /** The canonical absolute path, after `realpath`. Safe to open. */
  readonly absolutePath: string;
  /** The canonical project-relative path; `''` for the project root. */
  readonly relativePath: string;
  readonly segments: readonly string[];
}

/**
 * Maps a filesystem error to the workspace's normalized vocabulary.
 *
 * Reads only `code`, never `message` — an `errno` message contains the full
 * path, which must not reach a thrown error that might later be logged or
 * shown. Anything unrecognised becomes the generic read failure rather than
 * being passed through.
 */
export function toWorkspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new WorkspaceError('WORKSPACE_NOT_FOUND');
  if (code === 'EACCES' || code === 'EPERM') return new WorkspaceError('WORKSPACE_ACCESS_DENIED');
  if (code === 'EISDIR' || code === 'ELOOP' || code === 'ENAMETOOLONG') {
    return new WorkspaceError('WORKSPACE_UNSUPPORTED_ENTRY');
  }
  return new WorkspaceError('WORKSPACE_READ_FAILED');
}

/**
 * Resolves one renderer-supplied relative path against an approved project
 * root, or throws a {@link WorkspaceError}.
 *
 * `rootPath` must already be canonical — `adoptProjectDirectory` runs
 * `realpath` on it once, at selection time, so this function compares two
 * canonical paths rather than one canonical and one not.
 */
export async function resolveProjectPath(
  rootPath: string,
  requestedPath: unknown,
): Promise<ResolvedProjectPath> {
  const normalized = normalizeWorkspaceRelativePath(requestedPath);
  if (!normalized.ok) throw new WorkspaceError('WORKSPACE_INVALID_PATH');

  if (containsExcludedSegment(normalized.segments)) {
    throw new WorkspaceError('WORKSPACE_PATH_EXCLUDED');
  }

  const joined =
    normalized.segments.length === 0
      ? resolve(rootPath)
      : resolve(rootPath, ...normalized.segments);

  // Cannot fail given the lexical rules above; kept because "cannot fail" is
  // a claim about today's rules, and this is the check that would catch it if
  // one of them were ever loosened.
  if (!isContainedPath(rootPath, joined)) {
    throw new WorkspaceError('WORKSPACE_PATH_OUTSIDE_PROJECT');
  }

  let canonical: string;
  try {
    canonical = await realpath(joined);
  } catch (error) {
    throw toWorkspaceError(error);
  }

  // The check that actually catches a symbolic link: `joined` was inside the
  // project by construction, `canonical` is where it really points.
  if (!isContainedPath(rootPath, canonical)) {
    throw new WorkspaceError('WORKSPACE_PATH_OUTSIDE_PROJECT');
  }

  return {
    absolutePath: canonical,
    relativePath: normalized.path,
    segments: normalized.segments,
  };
}

/**
 * Joins a directory's absolute path and one child name.
 *
 * A thin wrapper so the walk never builds an absolute path by string
 * concatenation, which is where separator and normalisation mistakes come
 * from.
 */
export function joinAbsolute(directory: string, name: string): string {
  return join(directory, name);
}
