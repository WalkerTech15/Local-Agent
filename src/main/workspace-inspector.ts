/**
 * Read-only project inspection (Phase 2, Milestone 5).
 *
 * The only module in this codebase that reads a file the user chose, and it
 * has three functions: list a tree, read one text file, search for a
 * substring. There is no fourth. Nothing here opens a write handle, creates a
 * directory, renames, deletes, or spawns anything — `node:fs/promises` is
 * imported for exactly `readdir`, `readFile` and `stat`, and that import list
 * is the whole of this module's filesystem capability.
 *
 * Every path reaching a syscall here came through
 * `workspace-paths.ts`'s `resolveProjectPath`, so it is lexically safe,
 * carries no excluded segment, and has been proven — after `realpath` — to
 * live inside the approved root. Names discovered *by* the walk are held to
 * the identical rule before they are ever returned, so a path the renderer
 * receives is always one it can legally send back.
 *
 * Everything is bounded. A tree stops at a depth, an entry count and a
 * per-directory count; a file is refused above a byte cap rather than
 * truncated; a search stops at a match count and a scanned-file count. Each
 * bound reports itself (`truncated`) rather than silently shortening a
 * result, because a listing that quietly omits half a project is one a reader
 * would draw the wrong conclusion from.
 *
 * **Nothing here logs.** No `console` call, no path in a thrown message: a
 * file's contents and a user's directory layout are exactly the material the
 * milestone brief says must not reach a log.
 */

import { readdir, readFile, stat } from 'node:fs/promises';

import { joinAbsolute, resolveProjectPath, toWorkspaceError } from './workspace-paths';
import type { ApprovedProject } from './workspace-session';
import {
  BIDI_CONTROL_PATTERN,
  WORKSPACE_BINARY_SNIFF_BYTES,
  WORKSPACE_MAX_DIRECTORY_ENTRIES,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_FILE_CONTENT_LENGTH,
  WORKSPACE_MAX_SEARCH_FILES,
  WORKSPACE_MAX_SEARCH_RESULTS,
  WORKSPACE_MAX_TREE_DEPTH,
  WORKSPACE_MAX_TREE_ENTRIES,
  WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH,
  WORKSPACE_SEARCH_MAX_FILE_BYTES,
} from '../shared/constants';
import type {
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
  WorkspaceTree,
} from '../shared/schemas/workspace.schema';
import { WorkspaceError } from '../shared/workspace/errors';
import { hasBinaryFileExtension, isExcludedEntryName } from '../shared/workspace/exclusions';
import { isSafeWorkspaceRelativePath, joinWorkspacePath } from '../shared/workspace/path-safety';

/** One directory entry the walk decided to keep, before it was described. */
interface WalkCandidate {
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly depth: number;
  readonly excluded: boolean;
}

/**
 * Reads and orders one directory's usable children.
 *
 * Skips, without reporting an error:
 *
 *  - anything that is neither a regular file nor a directory. This is what
 *    keeps symbolic links out of the walk entirely, and with them both
 *    directory loops (`a -> ..`) and escapes; sockets, FIFOs and device nodes
 *    go the same way, since none is something a code viewer should open. A
 *    symlinked file can still be opened *directly*, by path, where
 *    `resolveProjectPath` proves the link stays inside the project — the walk
 *    simply does not offer it.
 *  - any name this codebase's own path rules would refuse (a control
 *    character, a bidirectional override, a reserved device name, a trailing
 *    dot). Listing such a name would offer the renderer a path it could never
 *    legally send back.
 */
async function readDirectoryCandidates(
  directoryAbsolute: string,
  directoryRelative: string,
  depth: number,
): Promise<{ readonly candidates: readonly WalkCandidate[]; readonly truncated: boolean }> {
  const dirents = await readdir(directoryAbsolute, { withFileTypes: true });

  const usable = dirents
    .filter((dirent) => dirent.isFile() || dirent.isDirectory())
    .filter((dirent) => isSafeWorkspaceRelativePath(dirent.name));

  usable.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });

  const kept = usable.slice(0, WORKSPACE_MAX_DIRECTORY_ENTRIES);
  const candidates = kept.map((dirent): WalkCandidate => {
    const kind = dirent.isDirectory() ? ('directory' as const) : ('file' as const);
    return {
      name: dirent.name,
      kind,
      absolutePath: joinAbsolute(directoryAbsolute, dirent.name),
      relativePath: joinWorkspacePath(directoryRelative, dirent.name),
      depth,
      excluded: isExcludedEntryName(dirent.name, kind),
    };
  });

  return { candidates, truncated: kept.length < usable.length };
}

/** A file's size in bytes, or `null` when it cannot be determined. */
async function fileSize(absolutePath: string): Promise<number | null> {
  try {
    const stats = await stat(absolutePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

async function describeCandidate(candidate: WalkCandidate): Promise<WorkspaceEntry> {
  const base = {
    path: candidate.relativePath,
    name: candidate.name,
    kind: candidate.kind,
    depth: candidate.depth,
    excluded: candidate.excluded,
  };

  if (candidate.kind === 'directory') {
    return { ...base, readable: false };
  }

  const size = await fileSize(candidate.absolutePath);
  const readable =
    !candidate.excluded &&
    !hasBinaryFileExtension(candidate.name) &&
    size !== null &&
    size <= WORKSPACE_MAX_FILE_BYTES;

  return { ...base, ...(size === null ? {} : { size }), readable };
}

/**
 * Lists a bounded, depth-first tree below one directory of the approved
 * project.
 *
 * Depth-first (pre-order) rather than breadth-first so entries arrive in the
 * order a tree is drawn — a directory immediately followed by its children —
 * which is what lets the interface render a flat, indented list without
 * rebuilding the hierarchy.
 *
 * An excluded directory is **listed and not descended into**. Hiding it would
 * make the tree quietly disagree with what is on disk; the flag tells the
 * reader why nothing is shown beneath it.
 *
 * A subdirectory that cannot be read (permissions, or removed mid-walk) is
 * skipped and the walk continues — one unreadable directory must not fail the
 * listing of an entire project. The *starting* directory is different: if
 * that cannot be read, the caller asked for something it cannot have, and the
 * error propagates.
 */
export async function listProjectTree(
  project: ApprovedProject,
  requestedPath: unknown,
): Promise<WorkspaceTree> {
  const root = await resolveProjectPath(project.rootPath, requestedPath);

  let rootStats;
  try {
    rootStats = await stat(root.absolutePath);
  } catch (error) {
    throw toWorkspaceError(error);
  }
  if (!rootStats.isDirectory()) throw new WorkspaceError('WORKSPACE_UNSUPPORTED_ENTRY');

  const entries: WorkspaceEntry[] = [];
  let truncated = false;

  let initial;
  try {
    initial = await readDirectoryCandidates(root.absolutePath, root.relativePath, 0);
  } catch (error) {
    throw toWorkspaceError(error);
  }
  if (initial.truncated) truncated = true;

  // Reversed on push so the stack pops them back in sorted order.
  const stack: WalkCandidate[] = [...initial.candidates].reverse();

  while (stack.length > 0) {
    if (entries.length >= WORKSPACE_MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }

    const candidate = stack.pop();
    if (candidate === undefined) break;

    entries.push(await describeCandidate(candidate));

    if (candidate.kind !== 'directory' || candidate.excluded) continue;
    if (candidate.depth + 1 > WORKSPACE_MAX_TREE_DEPTH) {
      truncated = true;
      continue;
    }

    try {
      const child = await readDirectoryCandidates(
        candidate.absolutePath,
        candidate.relativePath,
        candidate.depth + 1,
      );
      if (child.truncated) truncated = true;
      for (let index = child.candidates.length - 1; index >= 0; index -= 1) {
        const next = child.candidates[index];
        if (next !== undefined) stack.push(next);
      }
    } catch {
      // One unreadable subdirectory does not fail the whole listing.
      truncated = true;
    }
  }

  return { root: root.relativePath, entries, truncated };
}

/** True when a NUL appears in the sampled prefix — the standard "not text" test. */
function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, WORKSPACE_BINARY_SNIFF_BYTES);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * Reads one text file from the approved project.
 *
 * Refusals, in the order they are checked — each one before any content
 * exists in memory, except the last two, which need the bytes:
 *
 *  1. not a regular file          → `WORKSPACE_UNSUPPORTED_ENTRY`
 *  2. larger than the hard cap    → `WORKSPACE_FILE_TOO_LARGE`
 *  3. binary by extension         → `WORKSPACE_BINARY_FILE`
 *  4. NUL in the first bytes read → `WORKSPACE_BINARY_FILE`
 *  5. not valid UTF-8             → `WORKSPACE_BINARY_FILE`
 *
 * Exclusion (a credential file, or anything under an excluded directory) was
 * already refused by `resolveProjectPath`, at every segment of the path
 * rather than only its last one.
 *
 * Oversized files are **refused, not truncated**: a partial source file
 * invites a reader to conclude something from text that was silently cut off.
 */
export async function readProjectFile(
  project: ApprovedProject,
  requestedPath: unknown,
): Promise<WorkspaceFile> {
  const target = await resolveProjectPath(project.rootPath, requestedPath);
  const name = target.segments[target.segments.length - 1];
  if (name === undefined) throw new WorkspaceError('WORKSPACE_UNSUPPORTED_ENTRY');

  let stats;
  try {
    stats = await stat(target.absolutePath);
  } catch (error) {
    throw toWorkspaceError(error);
  }
  if (!stats.isFile()) throw new WorkspaceError('WORKSPACE_UNSUPPORTED_ENTRY');
  if (stats.size > WORKSPACE_MAX_FILE_BYTES) {
    throw new WorkspaceError('WORKSPACE_FILE_TOO_LARGE');
  }
  if (hasBinaryFileExtension(name)) throw new WorkspaceError('WORKSPACE_BINARY_FILE');

  let buffer: Buffer;
  try {
    buffer = await readFile(target.absolutePath);
  } catch (error) {
    throw toWorkspaceError(error);
  }

  // Re-checked against what was actually read, not only against the size
  // `stat` reported a moment earlier.
  if (buffer.length > WORKSPACE_MAX_FILE_BYTES) {
    throw new WorkspaceError('WORKSPACE_FILE_TOO_LARGE');
  }
  if (looksBinary(buffer)) throw new WorkspaceError('WORKSPACE_BINARY_FILE');

  let content: string;
  try {
    // `fatal: true` is the point: a file that is not valid UTF-8 must be
    // refused, not silently rendered full of replacement characters as though
    // it had been read correctly.
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new WorkspaceError('WORKSPACE_BINARY_FILE');
  }

  if (content.length > WORKSPACE_MAX_FILE_CONTENT_LENGTH) {
    throw new WorkspaceError('WORKSPACE_FILE_TOO_LARGE');
  }

  const warnings = BIDI_CONTROL_PATTERN.test(content)
    ? (['bidirectional-control-characters'] as const)
    : ([] as const);

  return {
    metadata: {
      path: target.relativePath,
      name,
      size: buffer.length,
      lineCount: content.length === 0 ? 0 : content.split('\n').length,
      encoding: 'utf-8',
      warnings: [...warnings],
    },
    content,
  };
}

/**
 * Makes one line safe to show in a results list.
 *
 * Control characters become spaces and bidirectional overrides are dropped
 * outright. This is the one place in the workspace where text is altered
 * rather than shown as stored, and the asymmetry is deliberate: an excerpt is
 * already a lossy fragment, and a results list is exactly where a line
 * reordered by a bidi override would be most convincing and least likely to
 * be double-checked. Whole-file content is never rewritten this way — it is
 * shown verbatim, with a warning.
 *
 * Written as a character walk rather than a regular expression so no control
 * character has to appear in this file's own source.
 */
function sanitizeExcerpt(line: string): string {
  let out = '';
  for (const character of line) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
      continue;
    }
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += character;
  }
  return out;
}

/** A bounded window of the line, centred on the match. */
function buildExcerpt(line: string, matchIndex: number): string {
  const sanitized = sanitizeExcerpt(line);
  if (sanitized.length <= WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH) return sanitized.trim();
  const start = Math.max(0, matchIndex - Math.floor(WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH / 3));
  return sanitized.slice(start, start + WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH).trim();
}

/** Every file the search may open, in tree order, already bounded. */
async function collectSearchableFiles(
  project: ApprovedProject,
  requestedPath: unknown,
): Promise<{ readonly files: readonly WorkspaceEntry[]; readonly truncated: boolean }> {
  const tree = await listProjectTree(project, requestedPath);
  const files = tree.entries.filter((entry) => entry.kind === 'file' && entry.readable);
  return { files, truncated: tree.truncated };
}

/**
 * Searches for a literal substring inside the approved project.
 *
 * **Never a regular expression.** The query comes from a text field, and
 * compiling user input as a pattern is how a search box becomes a denial of
 * service against the process that owns every privileged operation in this
 * application. Matching is a case-insensitive `indexOf`, and nothing else.
 *
 * At most one match is reported per line: a single minified line can contain
 * hundreds of occurrences, which would fill the whole result budget from one
 * file and tell the reader nothing they could act on.
 */
export async function searchProject(
  project: ApprovedProject,
  query: string,
  requestedPath: unknown,
): Promise<WorkspaceSearchResult> {
  const { files, truncated: treeTruncated } = await collectSearchableFiles(project, requestedPath);

  const needle = query.toLowerCase();
  const matches: WorkspaceSearchMatch[] = [];
  let filesScanned = 0;
  let truncated = treeTruncated;

  for (const file of files) {
    if (matches.length >= WORKSPACE_MAX_SEARCH_RESULTS) {
      truncated = true;
      break;
    }
    if (filesScanned >= WORKSPACE_MAX_SEARCH_FILES) {
      truncated = true;
      break;
    }
    if (file.size === undefined || file.size > WORKSPACE_SEARCH_MAX_FILE_BYTES) continue;

    let target;
    try {
      target = await resolveProjectPath(project.rootPath, file.path);
    } catch {
      // A file that vanished, or that turned out not to resolve inside the
      // project after all, is skipped — never searched on the strength of
      // having appeared in a listing a moment ago.
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(target.absolutePath);
    } catch {
      continue;
    }
    filesScanned += 1;
    if (looksBinary(buffer)) continue;

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (matches.length >= WORKSPACE_MAX_SEARCH_RESULTS) {
        truncated = true;
        break;
      }
      const line = lines[lineIndex] ?? '';
      const column = line.toLowerCase().indexOf(needle);
      if (column === -1) continue;
      matches.push({
        path: file.path,
        line: lineIndex + 1,
        column: column + 1,
        excerpt: buildExcerpt(line, column),
      });
    }
  }

  return { query, matches, filesScanned, truncated };
}
